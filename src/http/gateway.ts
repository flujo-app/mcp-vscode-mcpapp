import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http, { type Server as HttpServer } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import express from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { loginPage } from "./login.js";
import httpProxy from "http-proxy";
import type { Request, Response, NextFunction } from "express";
import type { VscodeCore } from "../core/core.js";
import type { OpenVscodeRuntime } from "../runtime/openvscode.js";
import { WorkbenchStreamController } from "../runtime/workbench-stream.js";
import { createMcpServer, type McpServerContext } from "../mcp/server.js";
import {
  bufferAndInjectHtmlResponse,
  isHtmlContentType,
  isMaybeHtmlDocumentRequest,
} from "./inject.js";
import {
  clearRuntimeBrokerEnvironment,
  FLUJO_RUNTIME_PROOF_CHALLENGE_HEADER,
  FLUJO_RUNTIME_PROOF_HEADER,
  FLUJO_RUNTIME_PROOF_PATH,
  registerRuntimeWithBroker,
  runtimeBrokerProof,
  type RuntimeBrokerRegistration,
} from "./runtime-registration.js";

export interface GatewayOptions {
  core: VscodeCore;
  runtime: OpenVscodeRuntime;
  host: string;
  port: number;
  publicUrl?: string;
  authToken?: string;
  tls?: { certPath: string; keyPath: string };
  appHtmlPath: string;
  /** Experimental, explicit opt-in; disabled unless render mode is `stream`. */
  stream?: {
    enabled: boolean;
    browserExecutable?: string;
    noSandbox?: boolean;
  };
  /** One-use FLUJO capability for publishing only the declared App routes. */
  runtimeBroker?: {
    registration: RuntimeBrokerRegistration;
    resourceUri: string;
  };
}

export class Gateway {
  readonly #options: GatewayOptions;
  readonly #proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    changeOrigin: false,
  });
  readonly #stream: WorkbenchStreamController;
  #server?: HttpServer;
  #origin = "";
  #runtimeProofToken?: string;
  #mcp?: ReturnType<typeof createMcpHandler>;

  constructor(options: GatewayOptions) {
    if (
      options.authToken !== undefined &&
      !/^[\x21-\x7e]{32,256}$/.test(options.authToken)
    )
      throw new Error(
        "HTTP token must contain 32–256 printable non-space characters",
      );
    // Stdio-only launches do not expose an unauthenticated companion MCP/debug API.
    this.#options = {
      ...options,
      authToken: options.authToken ?? randomBytes(32).toString("hex"),
    };
    if (options.publicUrl) {
      const u = new URL(options.publicUrl);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        u.hash
      )
        throw new Error("publicUrl must be an HTTP(S) origin");
    }
    this.#runtimeProofToken = options.runtimeBroker?.registration.token;
    this.#stream = new WorkbenchStreamController({
      enabled: options.stream?.enabled ?? false,
      runtime: options.runtime,
      ...(options.stream?.browserExecutable
        ? { browserExecutable: options.stream.browserExecutable }
        : {}),
      ...(options.stream?.noSandbox !== undefined
        ? { noSandbox: options.stream.noSandbox }
        : {}),
    });
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
      // workbench's module/fetch requests can arrive with Origin: null.
      // The explicit access gate admits that origin only for this unguessable
      // IDE capability, never for MCP, debug/session APIs or the bridge.
      if (request.headers.origin)
        proxyResponse.headers["access-control-allow-origin"] =
          request.headers.origin;
      else delete proxyResponse.headers["access-control-allow-origin"];
      proxyResponse.headers.vary = "Origin";
      proxyResponse.headers["cross-origin-resource-policy"] = "cross-origin";
      const csp = proxyResponse.headers["content-security-policy"];
      if (typeof csp === "string") {
        proxyResponse.headers["content-security-policy"] = csp
          .split(";")
          .filter(
            (directive) =>
              !directive.trim().toLowerCase().startsWith("frame-ancestors"),
          )
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
        response.writeHead(
          proxyResponse.statusCode ?? 200,
          proxyResponse.headers,
        );
        proxyResponse.pipe(response as unknown as NodeJS.WritableStream);
        return;
      }
      bufferAndInjectHtmlResponse(
        proxyResponse,
        response as unknown as Response,
      );
    });
    this.#proxy.on("error", (error, _request, response) => {
      if (response && "writeHead" in response && !response.headersSent) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "OpenVSCode proxy unavailable" }));
      }
    });
  }

  get origin(): string {
    return this.#origin;
  }

  get localBridgeUrl(): string {
    if (!this.#server) throw new Error("Gateway has not started");
    const address = this.#server.address() as AddressInfo;
    return `${this.#options.tls ? "wss" : "ws"}://127.0.0.1:${address.port}/bridge`;
  }

  async start(): Promise<{ origin: string; port: number }> {
    const app = express();
    app.use((request, response, next) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-content-type-options", "nosniff");
      const status = this.#accessStatus(request);
      if (status) {
        response
          .status(status)
          .json({ error: status === 421 ? "Invalid Host" : "Invalid Origin" });
        return;
      }
      next();
    });
    app.disable("x-powered-by");

    // This loopback-only proof is reachable while FLUJO performs the one-use
    // registration handshake. It is disabled immediately after that attempt.
    app.get(FLUJO_RUNTIME_PROOF_PATH, (request, response) => {
      const token = this.#runtimeProofToken;
      const challenge = request.header(FLUJO_RUNTIME_PROOF_CHALLENGE_HEADER);
      if (!token || !challenge) {
        response.status(404).end();
        return;
      }
      try {
        response.setHeader(
          FLUJO_RUNTIME_PROOF_HEADER,
          runtimeBrokerProof(token, challenge),
        );
        response.setHeader("cache-control", "no-store");
        response.status(204).end();
      } catch {
        response.status(400).end();
      }
    });

    app.get("/healthz", (_request, response) => {
      response.json({
        ok: true,
        service: "mcp-vscode",
        openVscode: this.#options.runtime.status().state,
        bridge: this.#options.core.bridge.status().connected,
      });
    });

    app.get(
      "/session.json",
      this.#browserAuth.bind(this),
      (_request, response) => {
        // The standalone debug page is same-origin. Do not make this endpoint
        // cross-origin readable: in stream mode its app-only payload contains
        // the authenticated viewer URL.
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        response.json(this.#sessionPayload());
      },
    );

    app.get(
      "/app",
      this.#browserAuth.bind(this),
      async (_request, response, next) => {
        try {
          const html = await readFile(this.#options.appHtmlPath, "utf8");
          const debug = `<script>window.__MCP_VSCODE_DEBUG__=${escapeInlineJson(this.#sessionPayload())}</script>`;
          response.setHeader("cache-control", "no-store");
          response.setHeader("x-content-type-options", "nosniff");
          response.setHeader("referrer-policy", "no-referrer");
          response
            .type("html")
            .send(html.replace("</head>", `${debug}</head>`));
        } catch (error) {
          next(error);
        }
      },
    );

    this.#mcp = createMcpHandler(() => createMcpServer(this.#mcpContext()), {
      legacy: "stateless",
    });
    const handleMcp = toNodeHandler(this.#mcp);
    app.options("/mcp", (request, response) => {
      if (request.headers.origin) {
        response.setHeader(
          "access-control-allow-origin",
          request.headers.origin,
        );
        response.setHeader("vary", "Origin");
      }
      response.setHeader("access-control-allow-methods", "POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
      );
      response.status(204).end();
    });
    app.all(
      "/mcp",
      this.#bearerAuth.bind(this),
      express.json({ limit: "8mb" }),
      async (request, response) => {
        if (request.headers.origin) {
          response.setHeader(
            "access-control-allow-origin",
            request.headers.origin,
          );
          response.setHeader("vary", "Origin");
        }
        if (request.method === "POST" && !request.is("application/json")) {
          response.status(415).json({ error: "Expected application/json" });
          return;
        }
        try {
          await handleMcp(request, response, request.body);
        } catch {
          if (!response.headersSent)
            response.status(500).json({ error: "Internal server error" });
        }
      },
    );
    app.use(
      (
        error: { status?: number },
        _request: Request,
        response: Response,
        _next: NextFunction,
      ) => {
        response
          .status(error.status === 413 ? 413 : 400)
          .json({
            error:
              error.status === 413 ? "Request body too large" : "Invalid JSON",
          });
      },
    );

    app.use((request, response, next) => {
      if (!request.path.startsWith(this.#options.runtime.basePath)) {
        next();
        return;
      }
      // Answer CORS preflights locally: the opaque-origin workbench iframe
      // preflights any fetch that carries custom headers, and OpenVSCode
      // itself does not speak CORS.
      if (
        request.method === "OPTIONS" &&
        request.headers["access-control-request-method"]
      ) {
        if (request.headers.origin)
          response.setHeader(
            "access-control-allow-origin",
            request.headers.origin,
          );
        response.setHeader("vary", "Origin");
        response.setHeader(
          "access-control-allow-methods",
          "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
        );
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
    nodeServer.requestTimeout = 30000;
    nodeServer.headersTimeout = 15000;
    nodeServer.on("upgrade", (request, socket, head) => {
      const denied = this.#accessStatus(request);
      if (denied) {
        socket.end(`HTTP/1.1 ${denied} Forbidden\r\nConnection: close\r\n\r\n`);
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/bridge") {
        this.#options.core.bridge.handleUpgrade(request, socket, head);
        return;
      }
      if (pathname === "/stream") {
        this.#stream.handleUpgrade(request, socket, head);
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
      nodeServer.listen(this.#options.port, this.#options.host, () =>
        resolve(),
      );
    });
    const address = nodeServer.address() as AddressInfo;
    const scheme = this.#options.tls ? "https" : "http";
    const localDisplayOrigin = `${scheme}://${loopbackDisplayHost(this.#options.host)}:${address.port}`;
    this.#origin =
      this.#options.publicUrl?.replace(/\/$/, "") ?? localDisplayOrigin;
    try {
      if (!this.#options.publicUrl && this.#options.runtimeBroker) {
        if (this.#options.tls) {
          throw new Error(
            "FLUJO's private runtime broker requires the child gateway to use loopback HTTP",
          );
        }
        const registration = await registerRuntimeWithBroker({
          broker: this.#options.runtimeBroker.registration,
          resourceUri: this.#options.runtimeBroker.resourceUri,
          targetOrigin: loopbackListenerOrigin(address),
          routes: [
            {
              path: this.#options.runtime.basePath,
              match: "prefix",
              httpMethods: [
                "GET",
                "HEAD",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "OPTIONS",
              ],
              websocket: true,
            },
            ...(this.#stream.enabled
              ? [{ path: "/stream", match: "exact" as const, websocket: true }]
              : []),
          ],
        });
        this.#origin = registration.publicOrigin;
        process.stderr.write(
          `[mcp-vscode] FLUJO App runtime published at ${registration.publicOrigin} (${registration.originKey})\n`,
        );
      }
    } catch (error) {
      this.#runtimeProofToken = undefined;
      if (this.#options.runtimeBroker) clearRuntimeBrokerEnvironment();
      await this.close().catch(() => undefined);
      throw error;
    }
    this.#runtimeProofToken = undefined;
    if (this.#options.runtimeBroker) clearRuntimeBrokerEnvironment();
    return { origin: this.#origin, port: address.port };
  }

  mcpContext(): McpServerContext {
    return this.#mcpContext();
  }

  async close(): Promise<void> {
    await this.#mcp?.close();
    await this.#stream.close();
    this.#proxy.close();
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.#server?.closeAllConnections(), 5000);
      timer.unref();
      this.#server?.close((error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      });
    });
    this.#server = undefined;
  }

  #mcpContext(): McpServerContext {
    if (!this.#origin)
      throw new Error("Gateway origin is unavailable before start");
    return {
      core: this.#options.core,
      runtime: this.#options.runtime,
      gatewayOrigin: this.#origin,
      appHtmlPath: this.#options.appHtmlPath,
      stream: this.#stream,
    };
  }

  #sessionPayload(): Record<string, unknown> {
    return {
      ...this.#options.core.status(),
      openVscode: this.#options.runtime.status(),
      ideUrl: this.#options.runtime.status().browserUrl,
      gatewayOrigin: this.#origin,
      stream: this.#stream.status(this.#origin),
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
    const supplied = request.headers.authorization;
    if (
      safeEqual(
        supplied?.startsWith("Bearer ") ? supplied.slice(7) : undefined,
        this.#options.authToken!,
      )
    ) {
      next();
      return;
    }
    if (request.path === "/app") {
      response.type("html").send(loginPage);
      return;
    }
    response.status(401).json({ error: "Unauthorized" });
  }

  #accessStatus(request: http.IncomingMessage): number | undefined {
    const address = this.#server?.address();
    const port =
      address && typeof address !== "string"
        ? address.port
        : this.#options.port;
    const scheme = this.#options.tls ? "https" : "http";
    const origins = new Set(
      ["127.0.0.1", "localhost", "[::1]"].map(
        (host) => new URL(`${scheme}://${host}:${port}`).origin,
      ),
    );
    for (const value of [this.#options.publicUrl, this.#origin])
      if (value) origins.add(new URL(value).origin);
    const hosts = new Set([...origins].map((origin) => new URL(origin).host));
    const rawHost = request.headers.host ?? "";
    if (!/^(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(:[0-9]{1,5})?$/.test(rawHost))
      return 421;
    // Compare authorities without trusting forwarded Host headers.
    if (!hosts.has(rawHost.toLowerCase())) return 421;
    const origin = request.headers.origin;
    if (!origin) return;
    if (origins.has(origin)) return;
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const base = this.#options.runtime.basePath.replace(/\/$/, "");
    // Opaque Apps may use only the unguessable IDE capability or token-protected stream.
    if (
      origin === "null" &&
      (pathname === base ||
        pathname.startsWith(base + "/") ||
        pathname === "/stream")
    )
      return;
    return 403;
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

function loopbackListenerOrigin(address: AddressInfo): string {
  const host = address.address;
  if (host === "0.0.0.0" || host === "::") {
    return `http://127.0.0.1:${address.port}`;
  }
  return `http://${loopbackDisplayHost(host)}:${address.port}`;
}

function escapeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}
