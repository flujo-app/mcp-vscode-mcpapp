import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import test from "node:test";
import {
  HTML_BUFFER_CAP_BYTES,
  LIVENESS_MARKER,
  appendLivenessScriptToCsp,
  bufferAndInjectHtmlResponse,
  injectLivenessScript,
  isHtmlContentType,
  isMaybeHtmlDocumentRequest,
  livenessScriptCspSource,
} from "../src/http/inject.js";

const LIVENESS_SCRIPT_BODY =
  'document.addEventListener("DOMContentLoaded",function(){try{parent.postMessage({type:"mcp-vscode:workbench-alive"},"*")}catch(e){}});';

test("injectLivenessScript prefers </head>, falls back to </body>, then prepends", () => {
  const withHead = injectLivenessScript("<html><head><title>t</title></head><body></body></html>");
  assert.equal(withHead.injected, true);
  assert.match(withHead.html, /<script>.*<\/head>/s);
  assert.ok(withHead.html.includes(LIVENESS_MARKER));

  const withBodyOnly = injectLivenessScript("<html><body>hello</body></html>");
  assert.equal(withBodyOnly.injected, true);
  assert.match(withBodyOnly.html, /<script>.*<\/body>/s);

  const withNeither = injectLivenessScript("plain text, no tags at all");
  assert.equal(withNeither.injected, true);
  assert.ok(withNeither.html.startsWith("<script>"));
  assert.ok(withNeither.html.endsWith("plain text, no tags at all"));
});

test("injectLivenessScript is idempotent: a document already carrying the marker is returned unchanged", () => {
  const original = `<html><head></head><body><script>${LIVENESS_SCRIPT_BODY}</script></body></html>`;
  const result = injectLivenessScript(original);
  assert.equal(result.injected, false);
  assert.equal(result.html, original);
});

test("livenessScriptCspSource returns a stable sha256 hash-source over the exact script body", () => {
  const expected = `'sha256-${createHash("sha256").update(LIVENESS_SCRIPT_BODY, "utf8").digest("base64")}'`;
  assert.equal(livenessScriptCspSource(), expected);
  // Deterministic across calls.
  assert.equal(livenessScriptCspSource(), livenessScriptCspSource());
});

test("appendLivenessScriptToCsp appends the hash to an existing script-src directive", () => {
  const hash = livenessScriptCspSource();
  const csp = "default-src 'self'; script-src 'self' https://cdn.example.test; style-src 'self'";
  const updated = appendLivenessScriptToCsp(csp);
  const scriptSrc = updated.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  assert.ok(scriptSrc, "expected a script-src directive");
  assert.match(scriptSrc!, /'self'/);
  assert.match(scriptSrc!, /https:\/\/cdn\.example\.test/);
  assert.ok(scriptSrc!.includes(hash));
  // Other directives are preserved untouched.
  assert.ok(updated.includes("default-src 'self'"));
  assert.ok(updated.includes("style-src 'self'"));
});

test("appendLivenessScriptToCsp synthesises a script-src directive when none exists", () => {
  const hash = livenessScriptCspSource();
  const csp = "default-src 'self'; style-src 'self'";
  const updated = appendLivenessScriptToCsp(csp);
  const scriptSrc = updated.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  assert.equal(scriptSrc, `script-src 'self' ${hash}`);
});

test("isMaybeHtmlDocumentRequest only matches GET requests that accept text/html", () => {
  assert.equal(isMaybeHtmlDocumentRequest("GET", "text/html,application/xhtml+xml"), true);
  assert.equal(isMaybeHtmlDocumentRequest("GET", "TEXT/HTML"), true);
  assert.equal(isMaybeHtmlDocumentRequest("POST", "text/html"), false);
  assert.equal(isMaybeHtmlDocumentRequest("GET", "application/json"), false);
  assert.equal(isMaybeHtmlDocumentRequest("GET", undefined), false);
  assert.equal(isMaybeHtmlDocumentRequest(undefined, "text/html"), false);
});

test("isHtmlContentType only matches a text/html content-type header, case-insensitively", () => {
  assert.equal(isHtmlContentType({ "content-type": "text/html; charset=utf-8" } as IncomingHttpHeaders), true);
  assert.equal(isHtmlContentType({ "content-type": "TEXT/HTML" } as IncomingHttpHeaders), true);
  assert.equal(isHtmlContentType({ "content-type": "application/json" } as IncomingHttpHeaders), false);
  assert.equal(isHtmlContentType({} as IncomingHttpHeaders), false);
  assert.equal(isHtmlContentType({ "content-type": ["text/html"] } as unknown as IncomingHttpHeaders), false);
});

interface CapturedResponse {
  headersSent: boolean;
  status?: number;
  headers?: IncomingHttpHeaders;
  chunks: Buffer[];
  ended: boolean;
}

function makeFakeResponse(): {
  response: {
    headersSent: boolean;
    writeHead(status: number, headers: IncomingHttpHeaders): unknown;
    write(chunk: Buffer): unknown;
    end(chunk?: Buffer): unknown;
  };
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { headersSent: false, chunks: [], ended: false };
  const response = {
    get headersSent() {
      return captured.headersSent;
    },
    writeHead(status: number, headers: IncomingHttpHeaders) {
      captured.headersSent = true;
      captured.status = status;
      captured.headers = headers;
      return response;
    },
    write(chunk: Buffer) {
      captured.chunks.push(chunk);
      return true;
    },
    end(chunk?: Buffer) {
      if (chunk) captured.chunks.push(chunk);
      captured.ended = true;
      return response;
    },
  };
  return { response, captured };
}

function makeFakeProxyResponse(statusCode: number, headers: IncomingHttpHeaders): IncomingMessage & EventEmitter {
  const emitter = new EventEmitter() as IncomingMessage & EventEmitter;
  (emitter as unknown as { statusCode: number }).statusCode = statusCode;
  (emitter as unknown as { headers: IncomingHttpHeaders }).headers = headers;
  return emitter;
}

test("bufferAndInjectHtmlResponse injects into HTML, recomputes content-length, and appends the CSP hash", async () => {
  const { response, captured } = makeFakeResponse();
  const proxyResponse = makeFakeProxyResponse(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": "999",
    "content-security-policy": "default-src 'self'; script-src 'self'",
  });

  bufferAndInjectHtmlResponse(proxyResponse, response);
  const original = "<html><head></head><body>hi</body></html>";
  proxyResponse.emit("data", Buffer.from(original, "utf8"));
  proxyResponse.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captured.status, 200);
  const body = Buffer.concat(captured.chunks).toString("utf8");
  assert.ok(body.includes(LIVENESS_MARKER));
  assert.equal(captured.headers?.["content-length"], String(Buffer.byteLength(body, "utf8")));
  assert.notEqual(captured.headers?.["content-length"], "999");
  const csp = captured.headers?.["content-security-policy"];
  assert.equal(typeof csp, "string");
  assert.ok((csp as string).includes(livenessScriptCspSource()));
  assert.ok(captured.ended);
});

test("the caller is responsible for gating on content-type: bufferAndInjectHtmlResponse itself only looks at the body", async () => {
  // bufferAndInjectHtmlResponse has no content-type check of its own -- it
  // always runs injectLivenessScript over the buffered body. The "never
  // injected into assets or non-HTML responses" invariant from the plan is
  // therefore enforced by the caller via isHtmlContentType()/
  // isMaybeHtmlDocumentRequest() *before* this function is ever invoked
  // (asserted separately above), and by the /assets route never being
  // proxied through this code path at all (it is served directly by
  // createAssetsHandler, asserted in tests/assets.test.ts). This test
  // documents that boundary precisely so a future change to either side
  // doesn't silently widen where injection happens.
  const { response, captured } = makeFakeResponse();
  const proxyResponse = makeFakeProxyResponse(200, { "content-type": "application/javascript" });

  bufferAndInjectHtmlResponse(proxyResponse, response);
  const original = "console.log('</head> looks like html but is not');";
  proxyResponse.emit("data", Buffer.from(original, "utf8"));
  proxyResponse.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  const body = Buffer.concat(captured.chunks).toString("utf8");
  assert.ok(body.includes(LIVENESS_MARKER), "bufferAndInjectHtmlResponse injects unconditionally by design");
});

test("bufferAndInjectHtmlResponse is idempotent when the marker is already present", async () => {
  const { response, captured } = makeFakeResponse();
  const proxyResponse = makeFakeProxyResponse(200, { "content-type": "text/html" });

  bufferAndInjectHtmlResponse(proxyResponse, response);
  const original = `<html><head><script>${LIVENESS_SCRIPT_BODY}</script></head><body></body></html>`;
  proxyResponse.emit("data", Buffer.from(original, "utf8"));
  proxyResponse.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  const body = Buffer.concat(captured.chunks).toString("utf8");
  assert.equal(body, original);
  assert.equal(captured.headers?.["content-security-policy"], undefined);
});

test("bufferAndInjectHtmlResponse pipes a response exceeding the buffering cap through unmodified", async () => {
  const { response, captured } = makeFakeResponse();
  const proxyResponse = makeFakeProxyResponse(200, { "content-type": "text/html" });

  bufferAndInjectHtmlResponse(proxyResponse, response);

  const chunkSize = 512 * 1024;
  const filler = "a".repeat(chunkSize);
  let sent = 0;
  const sentChunks: string[] = [];
  while (sent <= HTML_BUFFER_CAP_BYTES) {
    proxyResponse.emit("data", Buffer.from(filler, "utf8"));
    sentChunks.push(filler);
    sent += chunkSize;
  }
  // One more chunk after the cap has already been exceeded, to exercise the
  // direct write-through path (not just the flush-on-exceed path).
  const tail = "<html><head></head></html>";
  proxyResponse.emit("data", Buffer.from(tail, "utf8"));
  sentChunks.push(tail);
  proxyResponse.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  const body = Buffer.concat(captured.chunks).toString("utf8");
  assert.equal(body, sentChunks.join(""));
  // No injection: the marker never appears because pass-through mode never
  // calls injectLivenessScript.
  assert.ok(!body.includes(LIVENESS_MARKER));
  assert.equal(captured.headers?.["content-length"], undefined);
});

test("bufferAndInjectHtmlResponse falls back to a headers-only response on a proxy error before any data arrives", async () => {
  const { response, captured } = makeFakeResponse();
  const proxyResponse = makeFakeProxyResponse(502, { "content-type": "text/html" });

  bufferAndInjectHtmlResponse(proxyResponse, response);
  proxyResponse.emit("error", new Error("upstream reset"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captured.status, 502);
  assert.equal(captured.ended, true);
  assert.equal(Buffer.concat(captured.chunks).length, 0);
});
