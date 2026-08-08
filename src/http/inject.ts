import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

/**
 * A CSP-blocked frame never fires `load` and never fires `error`, so a
 * timeout on the app side is ambiguous ("still loading" vs. "framing
 * silently denied"). Injecting this script into the proxied workbench
 * document gives the app a *positive* signal that framing worked.
 */
const LIVENESS_SCRIPT_BODY =
  'document.addEventListener("DOMContentLoaded",function(){try{parent.postMessage({type:"mcp-vscode:workbench-alive"},"*")}catch(e){}});';
const LIVENESS_SCRIPT_TAG = `<script>${LIVENESS_SCRIPT_BODY}</script>`;
export const LIVENESS_MARKER = "mcp-vscode:workbench-alive";

/** Hard cap on how much of a proxied HTML response we will buffer in memory
 * before abandoning injection and falling back to an unmodified pass-through
 * of whatever remains — correctness (bounded memory) over cleverness. */
export const HTML_BUFFER_CAP_BYTES = 2 * 1024 * 1024;

export interface InjectionResult {
  html: string;
  injected: boolean;
}

/** Idempotent: a document that already carries the marker is returned as-is. */
export function injectLivenessScript(html: string): InjectionResult {
  if (html.includes(LIVENESS_MARKER)) return { html, injected: false };
  if (html.includes("</head>")) {
    return { html: html.replace("</head>", `${LIVENESS_SCRIPT_TAG}</head>`), injected: true };
  }
  if (html.includes("</body>")) {
    return { html: html.replace("</body>", `${LIVENESS_SCRIPT_TAG}</body>`), injected: true };
  }
  return { html: `${LIVENESS_SCRIPT_TAG}${html}`, injected: true };
}

/** `'sha256-<base64>'`, computed over the exact injected script body so it can
 * be appended to `script-src` as a CSP hash-source, keeping the injected
 * script self-contained even when the workbench forbids inline scripts. */
export function livenessScriptCspSource(): string {
  const digest = createHash("sha256").update(LIVENESS_SCRIPT_BODY, "utf8").digest("base64");
  return `'sha256-${digest}'`;
}

/** Appends the liveness script's hash-source to `script-src` (creating one,
 * scoped to `'self'` plus the hash, if the policy does not already declare
 * one). Assumes `frame-ancestors` has already been filtered by the caller. */
export function appendLivenessScriptToCsp(csp: string): string {
  const hashSource = livenessScriptCspSource();
  const directives = csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0);
  let sawScriptSrc = false;
  const updated = directives.map((directive) => {
    const [name, ...values] = directive.split(/\s+/);
    if (name?.toLowerCase() !== "script-src") return directive;
    sawScriptSrc = true;
    return [name, ...values, hashSource].join(" ");
  });
  if (!sawScriptSrc) updated.push(`script-src 'self' ${hashSource}`);
  return updated.join("; ");
}

/** `GET` requests that accept HTML are the only ones that can possibly be the
 * proxied `workbench.html` document; everything else (assets, XHR/fetch APIs,
 * WebSocket upgrades) is guaranteed not to need injection. This is a
 * pre-filter only — the actual decision to inject still gates on the
 * response's `content-type`, never on the URL. */
export function isMaybeHtmlDocumentRequest(method: string | undefined, acceptHeader: unknown): boolean {
  if (method !== "GET") return false;
  return typeof acceptHeader === "string" && acceptHeader.toLowerCase().includes("text/html");
}

export function isHtmlContentType(headers: IncomingHttpHeaders): boolean {
  const contentType = headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("text/html");
}

/**
 * Buffers a proxied HTML response (with a hard cap), injects the liveness
 * script before `</head>` (falling back to `</body>`, then prepending), fixes
 * up `content-security-policy` for the injected script, recomputes
 * `content-length`, and writes the result to `response`. If the response
 * exceeds the cap, buffering is abandoned and the remaining bytes are piped
 * through unmodified (already-read bytes are flushed as-is first).
 *
 * `response` must be a writable, header-mutable target (`http.ServerResponse`
 * or Express's `Response`, which extends it) obtained via
 * `selfHandleResponse: true` on the matching `proxy.web()` call, i.e. the
 * caller owns writing status/headers/body — `http-proxy`'s automatic
 * pipe-through must be disabled for this request.
 */
export function bufferAndInjectHtmlResponse(
  proxyResponse: IncomingMessage,
  response: { headersSent: boolean; writableEnded?: boolean; writeHead(status: number, headers: IncomingHttpHeaders): unknown; write(chunk: Buffer): unknown; end(chunk?: Buffer): unknown },
): void {
  const chunks: Buffer[] = [];
  let total = 0;
  let passthrough = false;

  const writeHeaders = (contentLength?: number): void => {
    if (response.headersSent) return;
    const headers: IncomingHttpHeaders = { ...proxyResponse.headers };
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    if (contentLength !== undefined) headers["content-length"] = String(contentLength);
    response.writeHead(proxyResponse.statusCode ?? 200, headers);
  };

  proxyResponse.on("data", (chunk: Buffer) => {
    if (passthrough) {
      response.write(chunk);
      return;
    }
    total += chunk.length;
    chunks.push(chunk);
    if (total > HTML_BUFFER_CAP_BYTES) {
      passthrough = true;
      // Cap exceeded: abandon injection. Flush what we already buffered
      // as-is (no content-length recompute possible any more) and switch
      // the remaining bytes to a direct write-through.
      writeHeaders();
      response.write(Buffer.concat(chunks));
      chunks.length = 0;
    }
  });
  proxyResponse.on("end", () => {
    if (passthrough) {
      response.end();
      return;
    }
    const original = Buffer.concat(chunks).toString("utf8");
    const { html, injected } = injectLivenessScript(original);
    if (injected) {
      const csp = proxyResponse.headers["content-security-policy"];
      if (typeof csp === "string") {
        proxyResponse.headers["content-security-policy"] = appendLivenessScriptToCsp(csp);
      }
    }
    const body = Buffer.from(html, "utf8");
    writeHeaders(body.length);
    response.end(body);
  });
  proxyResponse.on("error", () => {
    if (!response.headersSent) writeHeaders();
    response.end();
  });
}
