import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http, { type Server as HttpServer } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import httpProxy from "http-proxy";
import type { Request, Response, NextFunction } from "express";
import type { VscodeCore } from "../core/core.js";
import type { OpenVscodeRuntime } from "../runtime/openvscode.js";
import { createMcpServer, type McpServerContext } from "../mcp/server.js";
import { createAssetsHandler, defaultAssetsRoot } from "./assets.js";
import {
  bufferAndInjectHtmlResponse,
  isHtmlContentType,
  isMaybeHtmlDocumentRequest,
} from "./inject.js";
import { UiEditorSurface, UiSocketServer } from "./ui-socket.js";

export interface GatewayOptions {
  core: VscodeCore;
  runtime: OpenVscodeRuntime;
  host: string;
  port: number;
  publicUrl?: string;
  authToken?: string;
  tls?: { certPath: string; keyPath: string };
  appHtmlPath: string;
  /** Internal-only: overrides the static asset root, for tests. Not a CLI flag. */
  assetsRoot?: string;
}

export class Gateway {
  readonly #options: GatewayOptions;
  readonly #proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false });
  readonly #uiSocket: UiSocketServer;
  #server?: HttpServer;
  #origin = "";

  constructor(options: GatewayOptions) {
    this.#options = options;
    this.#uiSocket = new UiSocketServer(options.core);
    options.core.editorSurface.registerNative(new UiEditorSurface(this.#uiSocket));
    this.#proxy.on("proxyReq", (proxyRequest, request) => {
      if (isMaybeHtmlDocumentRequest(request.method, request.headers.accept)) {
        // Buffering the response for injection means we must never receive a
        // compressed body, or we would have to gunzip/brotli-decode it first.
        proxyRequest.setHeader("accept-encoding", "identity");
      }
    });
    this.#proxy.on("proxyRes", (proxyResponse, request, response) => {
      delete proxyResponse.headers["x-frame-options"];
      proxyResponse.headers["referrer-policy"] = "no-referrer";
      // The IDE is embedded in a sandboxed (opaque-origin) MCP-app iframe, so the
      // workbench's `<script type="module">` and fetch() calls arrive with
      // `Origin: null` and are CORS-checked. The gateway binds to loopback and
      // access is already gated by the unguessable base path (+ optional auth
      // token), so reflecting a wildcard here does not widen exposure.
      proxyResponse.headers["access-control-allow-origin"] = "*";
      proxyResponse.headers["cross-origin-resource-policy"] = "cross-origin";
      const csp = proxyResponse.headers["content-security-policy"];
      if (typeof csp === "string") {
        proxyResponse.headers["content-security-policy"] = csp
          .split(";")
          .filter((directive) => !directive.trim().toLowerCase().startsWith("frame-ancestors"))
          .join(";");
      }

      if (!isMaybeHtmlDocumentRequest(request.method, request.headers.accept)) {
        // `selfHandleResponse` was not requested for this proxy.web() call, so
        // http-proxy's default header-write + pipe-through still applies.
        return;
      }
      if (!isHtmlContentType(proxyResponse.headers)) {
        // We asked for manual control (selfHandleResponse) in case this turned
        // out to be the workbench document, but it wasn't one: replicate the
        // default pass-through ourselves, unmodified.
        response.writeHead(proxyResponse.statusCode ?? 200, proxyResponse.headers);
        proxyResponse.pipe(response as unknown as NodeJS.WritableStream);
        return;
      }
      bufferAndInjectHtmlResponse(proxyResponse, response as unknown as Response);
    });
    this.#proxy.on("error", (error, _request, response) => {
      if (response && "writeHead" in response && !response.headersSent) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "OpenVSCode proxy unavailable", message: error.message }));
      }
    });
  }

  get origin(): string {
    return this.#origin;
  }

  get localBridgeUrl(): string {
    if (!this.#server) throw new Error("Gateway has not started");
    const address = this.#server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}/bridge`;
  }

  async start(): Promise<{ origin: string; port: number }> {
    const app = createMcpExpressApp({ host: this.#options.host });
    app.disable("x-powered-by");

    app.get("/healthz", (_request, response) => {
      response.json({
        ok: true,
        service: "mcp-vscode",
        openVscode: this.#options.runtime.status().state,
        bridge: this.#options.core.bridge.status().connected,
      });
    });

    app.get("/session.json", this.#browserAuth.bind(this), (_request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      response.json(this.#sessionPayload());
    });

    app.get("/app", this.#browserAuth.bind(this), async (_request, response, next) => {
      try {
        const html = await readFile(this.#options.appHtmlPath, "utf8");
        const debug = `<script>window.__MCP_VSCODE_DEBUG__=${escapeInlineJson(this.#sessionPayload())}</script>`;
        response.type("html").send(html.replace("</head>", `${debug}</head>`));
      } catch (error) {
        next(error);
      }
    });

    // Registered before the basePath/503 gate below: the static asset bundle
    // must be reachable while OpenVSCode is still starting. Unauthenticated by
    // design (public, non-secret static code fetched from a sandboxed document
    // that cannot attach our token) — see the /ui socket for the authenticated
    // surface.
    app.use("/assets", createAssetsHandler({ root: this.#options.assetsRoot ?? defaultAssetsRoot }));

    app.all("/mcp", this.#bearerAuth.bind(this), async (request, response) => {
      const mcpServer = createMcpServer(this.#mcpContext());
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => {
        transport.close().catch(() => undefined);
        mcpServer.close().catch(() => undefined);
      });
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        process.stderr.write(`[mcp] ${error instanceof Error ? error.stack : String(error)}\n`);
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    app.use((request, response, next) => {
      if (!request.path.startsWith(this.#options.runtime.basePath)) {
        next();
        return;
      }
      // Answer CORS preflights locally: the opaque-origin workbench iframe
      // preflights any fetch that carries custom headers, and OpenVSCode
      // itself does not speak CORS.
      if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
        response.setHeader("access-control-allow-origin", "*");
        response.setHeader("access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
        response.setHeader(
          "access-control-allow-headers",
          typeof request.headers["access-control-request-headers"] === "string"
            ? request.headers["access-control-request-headers"]
            : "*",
        );
        response.setHeader("access-control-max-age", "86400");
        response.status(204).end();
        return;
      }
      const target = this.#options.runtime.target;
      if (!target) {
        response.status(503).json({
          error: "OPENVSCODE_NOT_READY",
          runtime: this.#options.runtime.status(),
        });
        return;
      }
      this.#proxy.web(request, response, {
        target,
        ...(isMaybeHtmlDocumentRequest(request.method, request.headers.accept)
          ? { selfHandleResponse: true }
          : {}),
      });
    });

    const nodeServer = this.#options.tls
      ? https.createServer(
          {
            cert: await readFile(this.#options.tls.certPath),
            key: await readFile(this.#options.tls.keyPath),
          },
          app,
        )
      : http.createServer(app);
    this.#server = nodeServer;
    nodeServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/bridge") {
        this.#options.core.bridge.handleUpgrade(request, socket, head);
        return;
      }
      if (pathname === "/ui") {
        this.#uiSocket.handleUpgrade(request, socket, head);
        return;
      }
      if (pathname.startsWith(this.#options.runtime.basePath)) {
        const target = this.#options.runtime.target;
        if (target) this.#proxy.ws(request, socket, head, { target });
        else socket.destroy();
        return;
      }
      socket.destroy();
    });

    await new Promise<void>((resolve, reject) => {
      nodeServer.once("error", reject);
      nodeServer.listen(this.#options.port, this.#options.host, () => resolve());
    });
    const address = nodeServer.address() as AddressInfo;
    const scheme = this.#options.tls ? "https" : "http";
    this.#origin = this.#options.publicUrl?.replace(/\/$/, "")
      ?? `${scheme}://${loopbackDisplayHost(this.#options.host)}:${address.port}`;
    return { origin: this.#origin, port: address.port };
  }

  mcpContext(): McpServerContext {
    return this.#mcpContext();
  }

  async close(): Promise<void> {
    this.#proxy.close();
    this.#uiSocket.close();
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) => {
      this.#server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.#server = undefined;
  }

  #mcpContext(): McpServerContext {
    if (!this.#origin) throw new Error("Gateway origin is unavailable before start");
    return {
      core: this.#options.core,
      runtime: this.#options.runtime,
      gatewayOrigin: this.#origin,
      appHtmlPath: this.#options.appHtmlPath,
    };
  }

  #sessionPayload(): Record<string, unknown> {
    return {
      ...this.#options.core.status(),
      openVscode: this.#options.runtime.status(),
      ideUrl: this.#options.runtime.status().browserUrl,
      gatewayOrigin: this.#origin,
      uiToken: this.#options.core.bridgeToken,
      assetsUrl: `${this.#origin}/assets`,
    };
  }

  #bearerAuth(request: Request, response: Response, next: NextFunction): void {
    const expected = this.#options.authToken;
    if (!expected) {
      next();
      return;
    }
    const value = request.headers.authorization;
    const token = value?.startsWith("Bearer ") ? value.slice(7) : undefined;
    if (!safeEqual(token, expected)) {
      response.setHeader("www-authenticate", "Bearer");
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  #browserAuth(request: Request, response: Response, next: NextFunction): void {
    const expected = this.#options.authToken;
    if (!expected || safeEqual(typeof request.query.token === "string" ? request.query.token : undefined, expected)) {
      next();
      return;
    }
    response.status(401).json({ error: "Unauthorized" });
  }
}

function safeEqual(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loopbackDisplayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

function escapeInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
