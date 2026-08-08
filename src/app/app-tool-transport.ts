// Host-neutral implementation of the native renderer transport. Instead of
// reaching back to the mcp-vscode process over its private `/ui` WebSocket,
// this transport uses the standard MCP Apps `tools/call` bridge that the host
// has already established for the app iframe.
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TransportError,
  type TransportEvent,
  type TransportStatus,
  type UiClientTransport,
} from "./transport.js";

const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TERMINAL_TAIL_CHARACTERS = 2_000_000;

const METHOD_TO_TOOL = {
  "workspace.list": "fs_list",
  "workspace.read": "fs_read",
  "workspace.write": "fs_write",
  "workspace.delete": "fs_delete",
  "workspace.move": "fs_move",
  "workspace.search": "fs_search",
  "terminal.create": "terminal_create",
  "terminal.list": "terminal_list",
  "terminal.read": "terminal_read",
  "terminal.write": "terminal_write",
  "terminal.resize": "terminal_resize",
  "terminal.close": "terminal_kill",
  "terminal.kill": "terminal_kill",
} as const satisfies Record<string, string>;

interface AttachedTerminal {
  output: string;
  exitEmitted: boolean;
}

interface TerminalSnapshot extends Record<string, unknown> {
  id?: string;
  output?: string;
  state?: string;
  exitCode?: number;
}

export interface AppToolTransportOptions {
  /** Polling replaces the gateway WebSocket's terminal event stream. */
  pollIntervalMs?: number;
  /** Must remain within `terminal_read`'s 2,000,000-character schema cap. */
  terminalTailCharacters?: number;
}

export class AppToolTransport implements UiClientTransport {
  readonly #app: Pick<App, "callServerTool">;
  readonly #pollIntervalMs: number;
  readonly #terminalTailCharacters: number;
  readonly #listeners = new Set<(event: TransportEvent) => void>();
  readonly #openListeners = new Set<() => void>();
  // Kept for structural compatibility with UiTransport. MCP Apps currently
  // provides no generic server-initiated tool-to-app RPC channel, so these
  // handlers cannot be dispatched by this transport.
  readonly #handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  readonly #attachedTerminals = new Map<string, AttachedTerminal>();
  #open = false;
  #pollTimer?: ReturnType<typeof globalThis.setTimeout>;
  #polling = false;

  onStatusChange?: (status: TransportStatus) => void;
  onGiveUp?: () => void;

  constructor(app: Pick<App, "callServerTool">, options: AppToolTransportOptions = {}) {
    this.#app = app;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#terminalTailCharacters = options.terminalTailCharacters ?? DEFAULT_TERMINAL_TAIL_CHARACTERS;
    if (!Number.isFinite(this.#pollIntervalMs) || this.#pollIntervalMs < 0) {
      throw new RangeError("pollIntervalMs must be a non-negative finite number");
    }
    if (
      !Number.isInteger(this.#terminalTailCharacters)
      || this.#terminalTailCharacters < 1
      || this.#terminalTailCharacters > DEFAULT_TERMINAL_TAIL_CHARACTERS
    ) {
      throw new RangeError("terminalTailCharacters must be an integer between 1 and 2,000,000");
    }
  }

  connect(): void {
    if (this.#open) return;
    this.#open = true;
    this.onStatusChange?.("open");
    for (const listener of this.#openListeners) listener();
    this.#ensurePolling();
  }

  close(): void {
    if (this.#pollTimer !== undefined) globalThis.clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#open = false;
    this.onStatusChange?.("closed");
  }

  get isOpen(): boolean {
    return this.#open;
  }

  async call(method: string, params?: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.#open) {
      throw new TransportError("NOT_CONNECTED", "The MCP Apps tool transport is not connected");
    }

    if (method === "terminal.attach") {
      const id = terminalIdFrom(params);
      if (!this.#attachedTerminals.has(id)) {
        this.#attachedTerminals.set(id, { output: "", exitEmitted: false });
      }
      const snapshot = await this.#readTerminal(id, timeoutMs);
      this.#ensurePolling();
      return snapshot;
    }

    const tool = METHOD_TO_TOOL[method as keyof typeof METHOD_TO_TOOL];
    if (!tool) throw new TransportError("METHOD_NOT_FOUND", `Unknown app-tool transport method: ${method}`);
    return await this.#callTool(tool, normalizeArguments(params), timeoutMs);
  }

  on(listener: (event: TransportEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onOpen(listener: () => void): () => void {
    this.#openListeners.add(listener);
    return () => this.#openListeners.delete(listener);
  }

  handle(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.#handlers.set(method, handler);
  }

  async #callTool(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    let result: CallToolResult;
    try {
      result = await this.#app.callServerTool(
        { name: tool, arguments: args },
        { timeout: timeoutMs },
      );
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError(
        "MCP_TOOL_CALL_FAILED",
        `MCP tool ${tool} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    return parseToolResult(tool, result);
  }

  async #readTerminal(id: string, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<TerminalSnapshot> {
    const snapshot = await this.#callTool(
      "terminal_read",
      { id, tailCharacters: this.#terminalTailCharacters },
      timeoutMs,
    ) as TerminalSnapshot;
    const attached = this.#attachedTerminals.get(id);
    if (!attached) return snapshot;

    const output = typeof snapshot.output === "string" ? snapshot.output : "";
    const delta = appendedOutput(attached.output, output);
    attached.output = output;
    if (delta) this.#emit("terminal.output", { id, data: delta });

    if (snapshot.state === "exited" && !attached.exitEmitted) {
      attached.exitEmitted = true;
      this.#emit("terminal.exited", { ...snapshot, id });
    }
    return snapshot;
  }

  #emit(event: string, data: unknown): void {
    for (const listener of this.#listeners) listener({ event, data });
  }

  #ensurePolling(): void {
    if (!this.#open || this.#pollTimer !== undefined || this.#polling || !this.#hasRunningAttachments()) return;
    this.#pollTimer = globalThis.setTimeout(() => {
      this.#pollTimer = undefined;
      void this.#pollAttached();
    }, this.#pollIntervalMs);
  }

  async #pollAttached(): Promise<void> {
    if (!this.#open || this.#polling) return;
    this.#polling = true;
    try {
      const ids = [...this.#attachedTerminals.entries()]
        .filter(([, terminal]) => !terminal.exitEmitted)
        .map(([id]) => id);
      await Promise.all(ids.map(async (id) => {
        try {
          await this.#readTerminal(id);
        } catch {
          // A transient host/tool failure should pause this sample, not tear
          // down the editor. The next poll retries through the same MCP Apps
          // channel; explicit user calls still receive their errors.
        }
      }));
    } finally {
      this.#polling = false;
      this.#ensurePolling();
    }
  }

  #hasRunningAttachments(): boolean {
    for (const terminal of this.#attachedTerminals.values()) {
      if (!terminal.exitEmitted) return true;
    }
    return false;
  }
}

function normalizeArguments(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new TransportError("INVALID_PARAMS", "MCP tool arguments must be an object");
  }
  return params as Record<string, unknown>;
}

function terminalIdFrom(params: unknown): string {
  const args = normalizeArguments(params);
  if (typeof args.id !== "string" || !args.id) {
    throw new TransportError("INVALID_PARAMS", "terminal.attach requires a terminal id");
  }
  return args.id;
}

function parseToolResult(tool: string, result: CallToolResult): Record<string, unknown> {
  const structured = asRecord(result.structuredContent);
  const text = firstText(result);
  const parsedText = parseJsonObject(text);
  const rawError = structured && Object.prototype.hasOwnProperty.call(structured, "error")
    ? structured.error
    : undefined;
  if (result.isError || rawError !== undefined) {
    const outerError = asRecord(rawError) ?? parsedText;
    const nestedError = asRecord(outerError?.error);
    const error = nestedError ?? outerError;
    const code = typeof error?.code === "string" ? error.code : "MCP_TOOL_ERROR";
    const message = typeof error?.message === "string"
      ? error.message
      : text ?? `MCP tool ${tool} returned an error`;
    throw new TransportError(code, message, error?.details ?? rawError ?? parsedText);
  }
  return structured ?? parsedText ?? {};
}

function firstText(result: CallToolResult): string | undefined {
  for (const part of result.content ?? []) {
    if (part.type === "text") return part.text;
  }
  return undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Returns only output appended since the previous terminal_read sample.
 * The common path is a cheap prefix check. Once TerminalManager's bounded
 * output buffer rolls over, a linear KMP scan finds the previous suffix that
 * became the current prefix, avoiding duplicate output without quadratic
 * string comparisons.
 */
function appendedOutput(previous: string, current: string): string {
  if (!previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length);
  if (!current) return "";

  const prefix = new Uint32Array(current.length);
  for (let index = 1, matched = 0; index < current.length; index += 1) {
    while (matched > 0 && current.charCodeAt(index) !== current.charCodeAt(matched)) {
      matched = prefix[matched - 1] ?? 0;
    }
    if (current.charCodeAt(index) === current.charCodeAt(matched)) matched += 1;
    prefix[index] = matched;
  }

  let overlap = 0;
  for (let index = 0; index < previous.length; index += 1) {
    const code = previous.charCodeAt(index);
    while (overlap > 0 && code !== current.charCodeAt(overlap)) overlap = prefix[overlap - 1] ?? 0;
    if (code === current.charCodeAt(overlap)) overlap += 1;
    if (overlap === current.length && index < previous.length - 1) overlap = prefix[overlap - 1] ?? 0;
  }
  return current.slice(overlap);
}
