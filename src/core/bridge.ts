import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { CoreEvents } from "./events.js";
import { McpVscodeError, serializeError } from "./errors.js";

export interface BridgeMessage {
  type: string;
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  event?: string;
  data?: unknown;
  token?: string;
  client?: { name?: string; version?: string; vscodeVersion?: string };
}

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class VscodeBridge {
  readonly #server = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
  });
  readonly #events: CoreEvents;
  readonly #token: string;
  readonly #pending = new Map<string, PendingRpc>();
  #socket?: WebSocket;
  #client?: BridgeMessage["client"];
  #droppedOutputBytes = 0;

  constructor(token: string, events: CoreEvents) {
    this.#token = token;
    this.#events = events;
    this.#server.on("connection", (socket) => this.#onConnection(socket));
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): void {
    this.#server.handleUpgrade(request, socket, head, (webSocket) => {
      this.#server.emit("connection", webSocket, request);
    });
  }

  status(): { connected: boolean; client?: BridgeMessage["client"] } {
    return {
      connected: this.#socket?.readyState === WebSocket.OPEN,
      ...(this.#client ? { client: this.#client } : {}),
    };
  }

  async call<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new McpVscodeError(
        "The OpenVSCode bridge is not connected yet",
        "VSCODE_BRIDGE_UNAVAILABLE",
      );
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new McpVscodeError("Invalid RPC timeout", "INVALID_TIMEOUT");
    if (this.#pending.size >= 256)
      throw new McpVscodeError(
        "Too many pending editor requests",
        "VSCODE_RPC_BUSY",
      );
    if (socket.bufferedAmount > 32 * 1024 * 1024) {
      socket.terminate();
      throw new McpVscodeError(
        "Bridge backpressure limit reached",
        "VSCODE_BACKPRESSURE",
      );
    }
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new McpVscodeError(
            `VS Code RPC timed out: ${method}`,
            "VSCODE_RPC_TIMEOUT",
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      // RPC calls are never silently dropped. Send failures settle the waiter immediately.
      const failed = (error?: Error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          new McpVscodeError("Bridge send failed", "VSCODE_RPC_SEND_FAILED"),
        );
      };
      try {
        socket.send(
          JSON.stringify({ type: "rpc", id, method, params }),
          failed,
        );
      } catch {
        failed(new Error("Send failed"));
      }
    });
  }

  broadcastEvent(event: string, data: unknown): void {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 32 * 1024 * 1024) {
      socket.terminate();
      return;
    }
    if (
      event === "terminal.output" &&
      socket.bufferedAmount > 8 * 1024 * 1024
    ) {
      this.#droppedOutputBytes += Buffer.byteLength(JSON.stringify(data));
      return;
    }
    if (this.#droppedOutputBytes && socket.bufferedAmount < 8 * 1024 * 1024) {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "terminal.output.dropped",
          data: { bytes: this.#droppedOutputBytes },
        }),
      );
      this.#droppedOutputBytes = 0;
    }
    // Low-volume state events remain deliverable until the hard disconnect ceiling.
    socket.send(JSON.stringify({ type: "event", event, data }));
  }

  close(): void {
    for (const socket of this.#server.clients) socket.terminate();
    this.#server.close();
    this.#rejectPending("VS Code bridge closed");
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new McpVscodeError(message, "VSCODE_BRIDGE_DISCONNECTED"));
    }
    this.#pending.clear();
  }

  #onConnection(socket: WebSocket): void {
    let authenticated = false;
    const authTimer = setTimeout(
      () => socket.close(4401, "Authentication timeout"),
      5_000,
    );
    socket.on("message", (raw) => {
      let message: BridgeMessage;
      try {
        message = JSON.parse(raw.toString()) as BridgeMessage;
      } catch {
        socket.close(4400, "Invalid JSON");
        return;
      }
      if (!authenticated) {
        if (
          message.type !== "hello" ||
          !safeTokenEqual(message.token, this.#token)
        ) {
          socket.close(4401, "Invalid bridge token");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        this.#rejectPending("VS Code bridge replaced");
        this.#socket?.terminate();
        this.#droppedOutputBytes = 0;
        this.#socket = socket;
        this.#client = message.client;
        socket.send(JSON.stringify({ type: "hello-result", ok: true }));
        this.#events.emit("vscode.connected", { client: message.client });
        return;
      }
      if (this.#socket === socket) this.#handleMessage(message);
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (this.#socket === socket) {
        this.#rejectPending("VS Code bridge disconnected");
        this.#socket = undefined;
        this.#client = undefined;
        this.#events.emit("vscode.disconnected", {});
      }
    });
    socket.on("error", (error) => {
      this.#events.emit("vscode.bridge-error", serializeError(error));
    });
  }

  #handleMessage(message: BridgeMessage): void {
    if (message.type === "rpc-result" && message.id) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new McpVscodeError(
            "VS Code RPC failed",
            "VSCODE_RPC_ERROR",
            message.error,
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    if (message.type === "event" && message.event) {
      this.#events.emit(`vscode.${message.event}`, message.data);
    }
  }
}

export function safeTokenEqual(
  value: string | undefined,
  expected: string,
): boolean {
  if (!value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
