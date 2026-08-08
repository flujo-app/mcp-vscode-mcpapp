// Native-tier terminal panel: xterm.js (loaded from the assets bundle) wired
// to the `/ui` transport's `terminal.*` RPCs and the `terminal.output`/
// `terminal.exited` core events. Only *types* are imported from
// "@xterm/xterm" (erased at compile time); the runtime module comes from
// `loadUiAssets`, same as the editor.
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { UiTransport } from "./transport.js";
import { loadUiAssets } from "./assets-loader.js";

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

    await this.createSession();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#resizeObserver?.disconnect();
    if (this.#resizeTimer !== undefined) window.clearTimeout(this.#resizeTimer);
    this.#terminal?.dispose();
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

  #scheduleResize(columns: number, rows: number): void {
    if (this.#resizeTimer !== undefined) window.clearTimeout(this.#resizeTimer);
    this.#resizeTimer = window.setTimeout(() => {
      if (!this.#id) return;
      void this.#transport.call("terminal.resize", { id: this.#id, columns, rows }).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  }
}
