import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { BridgeMessage } from "../core/bridge.js";
import { safeTokenEqual } from "../core/bridge.js";
import type { VscodeCore } from "../core/core.js";
import type { CoreEvent } from "../core/events.js";
import type { EditorSurface } from "../core/editor-surface.js";
import { McpVscodeError, serializeError } from "../core/errors.js";
import {
  terminalAttachSchema,
  terminalCreateSchema,
  terminalKillSchema,
  terminalResizeSchema,
  terminalWriteSchema,
  workspaceDeleteSchema,
  workspaceListSchema,
  workspaceMoveSchema,
  workspaceReadSchema,
  workspaceSearchSchema,
  workspaceWriteSchema,
} from "../mcp/schemas.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;
// Frames are dropped (not queued) once this much data is already buffered on
// the socket, so a slow/stalled client cannot grow our memory unboundedly.
const BACKPRESSURE_CEILING_BYTES = 8 * 1024 * 1024;
const DEFAULT_UI_RPC_TIMEOUT_MS = 10_000;

interface PendingUiRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * `/ui` WebSocket endpoint: same JSON-RPC framing as `VscodeBridge`
 * (`{ type: "rpc" | "event", ... }`), but calling core APIs directly instead
 * of round-tripping through the VS Code extension. Auth reuses
 * `core.bridgeToken`, passed as a `?token=` query parameter because browser
 * WebSocket clients cannot set custom headers.
 */
export class UiSocketServer {
  readonly #server = new WebSocketServer({ noServer: true });
  readonly #core: VscodeCore;
  readonly #pending = new Map<string, PendingUiRpc>();
  #socket?: WebSocket;
  #unsubscribe?: () => void;
  #heartbeat?: NodeJS.Timeout;
  readonly #attachedTerminals = new Set<string>();

  constructor(core: VscodeCore) {
    this.#core = core;
    this.#server.on("connection", (socket) => this.#onConnection(socket));
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? undefined;

    // The gateway binds to loopback by default, but --host can widen that;
    // assert loopback explicitly for this sensitive surface regardless.
    const remoteAddress = normalizeAddress(request.socket.remoteAddress);
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1") {
      rejectUpgrade(socket);
      return;
    }
    if (!safeTokenEqual(token, this.#core.bridgeToken)) {
      rejectUpgrade(socket);
      return;
    }

    this.#server.handleUpgrade(request, socket, head, (webSocket) => {
      this.#server.emit("connection", webSocket, request);
    });
  }

  /** Whether a native `/ui` renderer is currently connected. */
  status(): { attached: boolean } {
    return { attached: this.#socket?.readyState === WebSocket.OPEN };
  }

  /**
   * Server-initiated RPC to the attached `/ui` client, mirroring
   * `VscodeBridge.call()`. Rejects fast with `NO_EDITOR_SURFACE` when no
   * client is attached, with `UI_RPC_TIMEOUT` if it does not answer in time,
   * and with `UI_RPC_ERROR` if it answers with an error.
   */
  async call<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_UI_RPC_TIMEOUT_MS): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new McpVscodeError("No native /ui client is attached", "NO_EDITOR_SURFACE");
    }
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpVscodeError(`/ui RPC timed out: ${method}`, "UI_RPC_TIMEOUT"));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.#send(socket, { type: "rpc", id, method, params });
    });
  }

  close(): void {
    this.#socket?.close(1001, "Server shutting down");
    this.#server.close();
  }

  #onConnection(socket: WebSocket): void {
    if (this.#socket) {
      // Reject the newcomer rather than kicking the incumbent: unlike the
      // VS Code bridge (a single trusted extension host), a second /ui
      // client is more likely to be a stray tab than an intentional
      // reconnect.
      socket.close(4409, "UI socket already in use");
      return;
    }
    this.#socket = socket;
    this.#attachedTerminals.clear();

    let missedPongs = 0;
    socket.on("pong", () => {
      missedPongs = 0;
    });
    const heartbeat = setInterval(() => {
      if (missedPongs >= MAX_MISSED_PONGS) {
        socket.terminate();
        return;
      }
      missedPongs += 1;
      try {
        socket.ping();
      } catch {
        // Socket is already closing; the "close" handler will tear down state.
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.#heartbeat = heartbeat;

    this.#unsubscribe = this.#core.events.on((event) => this.#onCoreEvent(socket, event));

    socket.on("message", (raw) => this.#onMessage(socket, raw));
    socket.on("close", () => this.#onSocketClosed(socket));
    socket.on("error", () => {
      // The "close" event always follows; state teardown happens there.
    });
  }

  #onSocketClosed(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#attachedTerminals.clear();
    this.#socket = undefined;
    this.#rejectAllPending();
  }

  #rejectAllPending(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new McpVscodeError("The native /ui client disconnected", "NO_EDITOR_SURFACE"));
    }
    this.#pending.clear();
  }

  #onCoreEvent(socket: WebSocket, event: CoreEvent): void {
    if (event.type === "terminal.output") {
      const data = event.data as { id?: unknown };
      const id = typeof data.id === "string" ? data.id : undefined;
      if (!id || !this.#attachedTerminals.has(id)) return;
    }
    this.#send(socket, { type: "event", event: event.type, data: event.data });
  }

  #onMessage(socket: WebSocket, raw: unknown): void {
    let message: BridgeMessage;
    try {
      message = JSON.parse(rawToString(raw)) as BridgeMessage;
    } catch {
      socket.close(4400, "Invalid JSON");
      return;
    }
    // Reply to a server-initiated call() (new, additive discriminator; does
    // not collide with the legacy client->server `type: "rpc"` request shape).
    if (message.type === "rpc-result" && typeof message.id === "string") {
      this.#resolvePending(message);
      return;
    }
    if (message.type !== "rpc" || typeof message.id !== "string" || typeof message.method !== "string") {
      socket.close(4400, "Invalid message");
      return;
    }
    void this.#dispatch(socket, message.id, message.method, message.params);
  }

  #resolvePending(message: BridgeMessage): void {
    const id = message.id;
    if (!id) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new McpVscodeError("/ui RPC failed", "UI_RPC_ERROR", message.error));
    else pending.resolve(message.result);
  }

  async #dispatch(socket: WebSocket, id: string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#invoke(method, params);
      this.#send(socket, { type: "rpc", id, result });
    } catch (error) {
      this.#send(socket, { type: "rpc", id, error: serializeError(error) });
    }
  }

  async #invoke(method: string, params: unknown): Promise<unknown> {
    const core = this.#core;
    switch (method) {
      case "workspace.list": {
        const args = workspaceListSchema.parse(params ?? {});
        return { entries: await core.workspace.list(args.path, args.recursive, args.maxEntries) };
      }
      case "workspace.read": {
        const args = workspaceReadSchema.parse(params ?? {});
        return await core.workspace.read(args.path, args.encoding);
      }
      case "workspace.write": {
        const args = workspaceWriteSchema.parse(params ?? {});
        return await core.workspace.write(args);
      }
      case "workspace.delete": {
        const args = workspaceDeleteSchema.parse(params ?? {});
        return await core.workspace.delete(args.path, args.recursive);
      }
      case "workspace.move": {
        const args = workspaceMoveSchema.parse(params ?? {});
        return await core.workspace.move(args.from, args.to);
      }
      case "workspace.search": {
        const args = workspaceSearchSchema.parse(params ?? {});
        return { matches: await core.workspace.search(args) };
      }
      case "terminal.create": {
        const { cwd, ...rest } = terminalCreateSchema.parse(params ?? {});
        const absoluteCwd = await core.workspace.resolve(cwd);
        return await core.terminals.create({ cwd: absoluteCwd, ...rest });
      }
      case "terminal.write": {
        const args = terminalWriteSchema.parse(params ?? {});
        return core.terminals.write(args.id, args.data);
      }
      case "terminal.resize": {
        const args = terminalResizeSchema.parse(params ?? {});
        return core.terminals.resize(args.id, args.columns, args.rows);
      }
      case "terminal.close": {
        const args = terminalKillSchema.parse(params ?? {});
        return core.terminals.kill(args.id);
      }
      case "terminal.attach": {
        const args = terminalAttachSchema.parse(params ?? {});
        this.#attachedTerminals.add(args.id);
        return core.terminals.read(args.id);
      }
      case "editor.state": {
        // This handler is reached only when the native /ui client itself asks
        // for editor state (e.g. to render VS Code overlay info); it must not
        // call back into the editor-surface router, or a native client would
        // ask the gateway, which would ask the native client again.
        if (!core.bridge.status().connected) {
          throw new McpVscodeError(
            "No VS Code bridge is connected; the native renderer owns editor state.",
            "NO_EDITOR_SURFACE",
          );
        }
        return await core.bridge.call("editor.state");
      }
      default:
        throw new McpVscodeError(`Unknown /ui method: ${method}`, "METHOD_NOT_FOUND");
    }
  }

  #send(socket: WebSocket, message: BridgeMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > BACKPRESSURE_CEILING_BYTES) {
      // Coalesce by dropping: the next event of the same kind will supersede
      // this one, and RPC responses are never dropped because callers await
      // exactly one reply per request id (an occasional stalled reply is
      // preferable to unbounded memory growth).
      return;
    }
    socket.send(JSON.stringify(message));
  }
}

/**
 * `EditorSurface` adapter over the native `/ui` renderer, registered once by
 * the gateway on `core.editorSurface`. `available()` reads live socket
 * status; no register/unregister lifecycle is needed since there is at most
 * one `/ui` client.
 */
export class UiEditorSurface implements EditorSurface {
  readonly kind = "native" as const;
  readonly #ui: UiSocketServer;

  constructor(ui: UiSocketServer) {
    this.#ui = ui;
  }

  available(): boolean {
    return this.#ui.status().attached;
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.#ui.call<T>(method, params, timeoutMs);
  }
}

function rawToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString("utf8");
  return String(raw);
}

function rejectUpgrade(socket: Duplex): void {
  try {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  } catch {
    // The peer may have already disconnected.
  }
  socket.destroy();
}

function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  // IPv4-mapped IPv6 addresses (e.g. "::ffff:127.0.0.1") are reported for
  // dual-stack sockets bound to an IPv4 host.
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}
