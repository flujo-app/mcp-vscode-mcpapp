// Client for the gateway's authenticated `/ui` WebSocket (`src/http/ui-socket.ts`),
// used by the native (Tier 1) renderer for `workspace.*`/`terminal.*`/`editor.*`
// RPCs and for the core event stream. Same JSON-RPC-ish framing as the VS Code
// bridge extension (`{type:"rpc"|"event",...}`).
//
// Reconnects with jittered exponential backoff (500ms -> 1s -> 2s -> 4s ->
// 8s -> capped at 10s), unlimited attempts, mirroring the bridge extension's
// own retry shape. After 3 consecutive reconnect failures `onGiveUp` fires so
// the caller (`main.ts`) can tear the native tier down and re-run the tier
// probe from scratch (e.g. the gateway restarted on a different port).

export interface TransportEvent {
  event: string;
  data: unknown;
}

export type TransportStatus = "connecting" | "open" | "closed";

/**
 * Transport contract consumed by the Monaco explorer/editor/terminal shell.
 *
 * `UiTransport` implements it over the private gateway WebSocket. The
 * portable MCP-App renderer implements the same contract over
 * `App.callServerTool`, so the UI is not coupled to a publicly routable
 * sidecar port.
 */
export interface UiClientTransport {
  onStatusChange?: (status: TransportStatus) => void;
  onGiveUp?: () => void;
  readonly isOpen: boolean;
  connect(): void;
  close(): void;
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  on(listener: (event: TransportEvent) => void): () => void;
  onOpen(listener: () => void): () => void;
  handle(method: string, handler: (params: unknown) => Promise<unknown>): void;
}

interface RpcErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export class TransportError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "TransportError";
  }
}

const BACKOFF_STEPS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
const GIVE_UP_AFTER_FAILURES = 3;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;

export class UiTransport implements UiClientTransport {
  readonly #url: string;
  #socket?: WebSocket;
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly #listeners = new Set<(event: TransportEvent) => void>();
  readonly #openListeners = new Set<() => void>();
  readonly #handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  #closed = true;
  #attempt = 0;
  #consecutiveFailures = 0;
  #reconnectTimer?: number;

  onStatusChange?: (status: TransportStatus) => void;
  /** Fired once, after `GIVE_UP_AFTER_FAILURES` consecutive reconnect
   * failures. The transport keeps retrying regardless; this is purely a
   * signal for the caller to consider a full tier re-probe. */
  onGiveUp?: () => void;

  constructor(url: string) {
    this.#url = url;
  }

  connect(): void {
    this.#closed = false;
    this.#open();
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer !== undefined) window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#socket?.close(1000, "client closing");
    this.#socket = undefined;
    for (const pending of this.#pending.values()) pending.reject(new TransportError("CLOSED", "Transport closed"));
    this.#pending.clear();
  }

  get isOpen(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Client-initiated RPC, same framing as before. Now carries its own
   * timeout (default 15s, mitigating issue #12's "RPC that never resolves"
   * risk on the client side too -- the server side already has one).
   */
  call(method: string, params?: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new TransportError("NOT_CONNECTED", "The /ui transport is not connected"));
    }
    return new Promise((resolve, reject) => {
      const id = generateId();
      const timer = window.setTimeout(() => {
        this.#pending.delete(id);
        reject(new TransportError("UI_RPC_TIMEOUT", `/ui RPC timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ type: "rpc", id, method, params }));
    });
  }

  on(listener: (event: TransportEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Registers a handler for a server-initiated RPC method (the additive
   * `/ui` server->client channel, see `src/http/ui-socket.ts`). Replies are
   * sent back with the `rpc-result` discriminator so they never collide
   * with this transport's own outgoing `rpc` requests. */
  handle(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.#handlers.set(method, handler);
  }

  /** Fires every time the socket transitions to `open`, including on
   * reconnect (not just the initial connect) -- used by `NativeTerminal`
   * to re-issue `terminal.attach` for its known session id, since terminal
   * attachment does not survive a `/ui` reconnect (§6 note 7). */
  onOpen(listener: () => void): () => void {
    this.#openListeners.add(listener);
    return () => this.#openListeners.delete(listener);
  }

  #open(): void {
    if (this.#closed) return;
    this.onStatusChange?.("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#consecutiveFailures = 0;
      this.onStatusChange?.("open");
      for (const listener of this.#openListeners) listener();
    });
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("close", () => this.#onClose());
    socket.addEventListener("error", () => {
      // The "close" event always follows; teardown/reconnect happens there.
    });
  }

  #onMessage(event: MessageEvent): void {
    let message: {
      type?: string;
      id?: string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: RpcErrorPayload;
      event?: string;
      data?: unknown;
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    // Server-initiated RPC request (additive; carries `method`, unlike the
    // legacy reply-to-our-own-call shape below). Answered with
    // `{ type: "rpc-result", ... }` so it never collides with our own
    // pending-call bookkeeping.
    if (message.type === "rpc" && typeof message.id === "string" && typeof message.method === "string") {
      void this.#dispatchIncoming(message.id, message.method, message.params);
      return;
    }
    if (message.type === "rpc" && typeof message.id === "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new TransportError(message.error.code, message.error.message, message.error.details));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.type === "event" && typeof message.event === "string") {
      for (const listener of this.#listeners) listener({ event: message.event, data: message.data });
    }
  }

  async #dispatchIncoming(id: string, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    if (!handler) {
      this.#sendResult(id, undefined, { code: "METHOD_NOT_FOUND", message: `Unknown /ui method: ${method}` });
      return;
    }
    try {
      const result = await handler(params);
      this.#sendResult(id, result);
    } catch (error) {
      this.#sendResult(id, undefined, serializeHandlerError(error));
    }
  }

  #sendResult(id: string, result?: unknown, error?: RpcErrorPayload): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(error ? { type: "rpc-result", id, error } : { type: "rpc-result", id, result }));
  }

  #onClose(): void {
    this.#socket = undefined;
    for (const pending of this.#pending.values()) {
      pending.reject(new TransportError("DISCONNECTED", "The /ui transport disconnected"));
    }
    this.#pending.clear();
    if (this.#closed) {
      this.onStatusChange?.("closed");
      return;
    }
    this.#consecutiveFailures += 1;
    this.onStatusChange?.("connecting");
    if (this.#consecutiveFailures === GIVE_UP_AFTER_FAILURES) this.onGiveUp?.();
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    const step = BACKOFF_STEPS_MS[Math.min(this.#attempt, BACKOFF_STEPS_MS.length - 1)] ?? 10_000;
    this.#attempt += 1;
    const jittered = step * (0.8 + Math.random() * 0.4);
    if (this.#reconnectTimer !== undefined) window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = window.setTimeout(() => this.#open(), jittered);
  }
}

function serializeHandlerError(error: unknown): RpcErrorPayload {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    const err = error as { code: string; message?: string; details?: unknown };
    return { code: err.code, message: err.message ?? String(error), details: err.details };
  }
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
