import * as monaco from "monaco-editor/editor/editor.api.js";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

// Keep the same interface used by the native editor/terminal, but provide the
// implementation from this MCP App bundle itself.  The app document can have
// an opaque origin and the server's HTTP gateway can be loopback-only, so
// fetching a manifest and dynamically importing renderer code is not a safe
// baseline for hosted MCP clients.
export interface UiAssetsModule {
  installMonacoEnvironment(assetsUrl: string): Promise<void>;
  createEditor(container: HTMLElement, options?: { value?: string; language?: string }): unknown;
  createTerminal(container: HTMLElement): { terminal: unknown; fit: unknown };
  monaco: unknown;
}

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

const inlineAssets: UiAssetsModule = {
  async installMonacoEnvironment(_assetsUrl: string): Promise<void> {
    // MCP App hosts commonly disallow workers (and blob: workers) in their
    // sandbox CSP.  Throwing synchronously here activates Monaco's supported
    // in-process editor-worker fallback instead of attempting an HTTP import
    // from the server gateway.
    window.MonacoEnvironment = {
      getWorker(): Worker {
        throw new Error("Monaco workers are unavailable in this MCP App sandbox");
      },
    };
  },

  createEditor(
    container: HTMLElement,
    options: { value?: string; language?: string } = {},
  ): monaco.editor.IStandaloneCodeEditor {
    return monaco.editor.create(container, {
      value: options.value ?? "",
      language: options.language ?? "plaintext",
      automaticLayout: true,
      theme: "vs-dark",
    });
  },

  createTerminal(container: HTMLElement): { terminal: Terminal; fit: FitAddon } {
    const terminal = new Terminal({ convertEol: true });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    return { terminal, fit };
  },

  monaco,
};

let cached: Promise<UiAssetsModule> | undefined;

export function loadUiAssets(assetsUrl: string): Promise<UiAssetsModule> {
  cached ??= inlineAssets.installMonacoEnvironment(assetsUrl).then(() => inlineAssets);
  return cached;
}

/** Test/reset hook retained for tier re-probes. */
export function resetUiAssetsCache(): void {
  cached = undefined;
}
