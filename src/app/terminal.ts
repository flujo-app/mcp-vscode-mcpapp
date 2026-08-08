// Native-tier terminal panel: xterm.js (loaded from the assets bundle) wired
// to the `/ui` transport's `terminal.*` RPCs and the `terminal.output`/
// `terminal.exited` core events. Only *types* are imported from
// "@xterm/xterm" (erased at compile time); the runtime module comes from
// `loadUiAssets`, same as the editor.
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { UiTransport } from "./transport.js";
import { loadUiAssets } from "./assets-loader.js";
import type { HostTokenMap, ThemeMode } from "./theme.js";
import { buildXtermTheme } from "./theme.js";

const RESIZE_DEBOUNCE_MS = 100;

export class NativeTerminal {
  readonly #container: HTMLElement;
  readonly #transport: UiTransport;
  readonly #assetsUrl: string;
  readonly #workspaceRoot: string;
  #terminal?: XTerm;
  #fit?: FitAddon;
  #id?: string;
  #unsubscribe?: () => void;
  #unsubscribeOpen?: () => void;
  #resizeObserver?: ResizeObserver;
  #resizeTimer?: number;
  #disabled = false;

  constructor(container: HTMLElement, transport: UiTransport, assetsUrl: string, workspaceRoot: string) {
    this.#container = container;
    this.#transport = transport;
    this.#assetsUrl = assetsUrl;
    this.#workspaceRoot = workspaceRoot;
  }

  async mount(): Promise<void> {
    const assets = await loadUiAssets(this.#assetsUrl);
    const created = assets.createTerminal(this.#container) as { terminal: XTerm; fit: FitAddon };
    this.#terminal = created.terminal;
    this.#fit = created.fit;

    this.#unsubscribe = this.#transport.on((event) => {
      if (!this.#id) return;
      const data = event.data as { id?: string; data?: string; state?: string; exitCode?: number } | undefined;
      if (!data || data.id !== this.#id) return;
      if (event.event === "terminal.output" && typeof data.data === "string") {
        this.#terminal?.write(data.data);
      } else if (event.event === "terminal.exited") {
        this.#terminal?.write(`\r\n\x1b[2m[process exited: ${data.exitCode ?? "unknown"}]\x1b[0m\r\n`);
        this.#disabled = true;
      }
    });

    this.#terminal.onData((data) => {
      if (this.#disabled || !this.#id) return;
      void this.#transport.call("terminal.write", { id: this.#id, data }).catch(() => {
        // A write failure surfaces via the transport's own reconnect/give-up
        // path; nothing actionable to do at the per-keystroke level.
      });
    });
    this.#terminal.onResize(({ cols, rows }) => this.#scheduleResize(cols, rows));

    this.#resizeObserver = new ResizeObserver(() => this.#fit?.fit());
    this.#resizeObserver.observe(this.#container);

    // Terminal attachment (`terminal.attach`) is server-side, per-connection
    // state (`UiSocketServer.#attachedTerminals`) that does NOT survive a
    // `/ui` reconnect (issue #10 §6 note 7). Without this, a reconnected
    // native tier would silently stop receiving `terminal.output` for an
    // otherwise-still-running session.
    this.#unsubscribeOpen = this.#transport.onOpen(() => void this.#reattach());

    await this.createSession();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribeOpen?.();
    this.#resizeObserver?.disconnect();
    if (this.#resizeTimer !== undefined) window.clearTimeout(this.#resizeTimer);
    this.#terminal?.dispose();
  }

  /** Applies a host-derived xterm palette (plan §4.2). No-op before
   * `mount()` resolves. */
  applyTheme(tokens: HostTokenMap, mode: ThemeMode): void {
    if (!this.#terminal) return;
    const theme = buildXtermTheme(tokens, mode, { resolve: resolveComputedColor });
    this.#terminal.options.theme = theme;
  }

  async createSession(): Promise<void> {
    this.#disabled = false;
    try {
      const summary = (await this.#transport.call("terminal.create", {
        cwd: this.#workspaceRoot,
        columns: this.#terminal?.cols ?? 120,
        rows: this.#terminal?.rows ?? 30,
      })) as { id: string };
      this.#id = summary.id;
      await this.#transport.call("terminal.attach", { id: summary.id });
      this.#fit?.fit();
    } catch (error) {
      this.#terminal?.write(`\r\n\x1b[31mFailed to start a terminal: ${
        error instanceof Error ? error.message : String(error)
      }\x1b[0m\r\n`);
    }
  }

  /** Re-issues `terminal.attach` for the current session id after a
   * `/ui` reconnect. A no-op if no session has been created yet (the very
   * first "open" event, before `createSession()` has run). */
  async #reattach(): Promise<void> {
    if (!this.#id) return;
    try {
      await this.#transport.call("terminal.attach", { id: this.#id });
    } catch {
      // The transport's own reconnect/give-up path handles a durably
      // broken connection; a single failed re-attach is not actionable
      // here beyond leaving output paused until the next successful one.
    }
  }

  #scheduleResize(columns: number, rows: number): void {
    if (this.#resizeTimer !== undefined) window.clearTimeout(this.#resizeTimer);
    this.#resizeTimer = window.setTimeout(() => {
      if (!this.#id) return;
      void this.#transport.call("terminal.resize", { id: this.#id, columns, rows }).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  }
}

/** DOM-dependent colour resolver for `theme.ts#normalizeColor`, mirroring
 * `editor.ts`'s helper (kept duplicated rather than shared -- both files
 * are small, self-contained, and this avoids inventing a new shared module
 * outside this wave's file ownership). */
function resolveComputedColor(value: string): string | undefined {
  try {
    const probe = document.createElement("span");
    probe.style.color = value;
    if (!probe.style.color) return undefined;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved || undefined;
  } catch {
    return undefined;
  }
}
