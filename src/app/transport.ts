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

export class UiTransport {
  readonly #url: string;
  #socket?: WebSocket;
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly #listeners = new Set<(event: TransportEvent) => void>();
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

  call(method: string, params?: unknown): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new TransportError("NOT_CONNECTED", "The /ui transport is not connected"));
    }
    return new Promise((resolve, reject) => {
      const id = generateId();
      this.#pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "rpc", id, method, params }));
    });
  }

  on(listener: (event: TransportEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
    });
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("close", () => this.#onClose());
    socket.addEventListener("error", () => {
      // The "close" event always follows; teardown/reconnect happens there.
    });
  }

  #onMessage(event: MessageEvent): void {
    let message: { type?: string; id?: string; result?: unknown; error?: RpcErrorPayload; event?: string; data?: unknown };
    try {
      message = JSON.parse(String(event.data));
    } catch {
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

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
