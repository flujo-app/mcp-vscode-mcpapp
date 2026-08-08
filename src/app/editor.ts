// Native-tier editor: one Monaco model per open file (keyed by
// workspace-relative path), tabs kept alive across switches, disposed on tab
// close. Only *types* are imported from "monaco-editor" (erased at compile
// time) -- the actual runtime module is loaded cross-origin from the
// gateway's `/assets` bundle via `loadUiAssets`, never bundled into this
// (IIFE, same-document) `main.ts` bundle.
import type * as monaco from "monaco-editor/editor/editor.api.js";
import type { UiTransport } from "./transport.js";
import { loadUiAssets } from "./assets-loader.js";
import { TransportError } from "./transport.js";

interface OpenTab {
  path: string;
  model: monaco.editor.ITextModel;
  baseVersion: string;
  dirty: boolean;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  sh: "shellscript",
  txt: "plaintext",
};

export interface EditorHost {
  onDirtyChanged(path: string, dirty: boolean): void;
  onConflict(path: string, expected: string, actual: string): void;
  onError(message: string): void;
}

export class NativeEditor {
  readonly #container: HTMLElement;
  readonly #tabsBar: HTMLElement;
  readonly #transport: UiTransport;
  readonly #host: EditorHost;
  readonly #assetsUrl: string;
  readonly #tabs = new Map<string, OpenTab>();
  #activePath?: string;
  #monaco?: typeof monaco;
  #editor?: monaco.editor.IStandaloneCodeEditor;
  #unsubscribe?: () => void;

  constructor(container: HTMLElement, tabsBar: HTMLElement, transport: UiTransport, assetsUrl: string, host: EditorHost) {
    this.#container = container;
    this.#tabsBar = tabsBar;
    this.#transport = transport;
    this.#assetsUrl = assetsUrl;
    this.#host = host;
  }

  async mount(): Promise<void> {
    const assets = await loadUiAssets(this.#assetsUrl);
    this.#monaco = assets.monaco as typeof monaco;
    this.#editor = assets.createEditor(this.#container, {}) as monaco.editor.IStandaloneCodeEditor;
    const ctrlS = this.#monaco.KeyMod.CtrlCmd | this.#monaco.KeyCode.KeyS;
    this.#editor.addCommand(ctrlS, () => void this.#saveActive());

    this.#unsubscribe = this.#transport.on((event) => {
      if (event.event !== "workspace.changed") return;
      const data = event.data as { path?: string } | undefined;
      if (data?.path) void this.#onExternalChange(data.path);
    });
  }

  dispose(): void {
    this.#unsubscribe?.();
    for (const tab of this.#tabs.values()) tab.model.dispose();
    this.#tabs.clear();
    this.#editor?.dispose();
  }

  async openFile(path: string): Promise<void> {
    let tab = this.#tabs.get(path);
    if (!tab) {
      try {
        const result = (await this.#transport.call("workspace.read", { path, encoding: "utf8" })) as {
          content: string;
          version: string;
        };
        const monacoModule = await this.#ensureMonaco();
        const model = monacoModule.editor.createModel(result.content, languageFor(path));
        model.onDidChangeContent(() => this.#markDirty(path, true));
        tab = { path, model, baseVersion: result.version, dirty: false };
        this.#tabs.set(path, tab);
        this.#renderTabs();
      } catch (error) {
        this.#host.onError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    this.#activate(path);
  }

  closeTab(path: string): void {
    const tab = this.#tabs.get(path);
    if (!tab) return;
    if (tab.dirty && !window.confirm(`"${path}" has unsaved changes. Close anyway?`)) return;
    tab.model.dispose();
    this.#tabs.delete(path);
    if (this.#activePath === path) {
      this.#activePath = undefined;
      const next = [...this.#tabs.keys()][0];
      if (next) this.#activate(next);
      else this.#editor?.setModel(null);
    }
    this.#renderTabs();
  }

  async #ensureMonaco(): Promise<typeof monaco> {
    if (this.#monaco) return this.#monaco;
    throw new Error("NativeEditor.mount() must resolve before opening a file");
  }

  #activate(path: string): void {
    const tab = this.#tabs.get(path);
    if (!tab || !this.#editor) return;
    this.#activePath = path;
    this.#editor.setModel(tab.model);
    this.#renderTabs();
  }

  #markDirty(path: string, dirty: boolean): void {
    const tab = this.#tabs.get(path);
    if (!tab || tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.#host.onDirtyChanged(path, dirty);
    this.#renderTabs();
  }

  async #saveActive(): Promise<void> {
    if (!this.#activePath) return;
    await this.#save(this.#activePath);
  }

  async #save(path: string, expectedVersion?: string): Promise<void> {
    const tab = this.#tabs.get(path);
    if (!tab) return;
    try {
      const result = (await this.#transport.call("workspace.write", {
        path,
        content: tab.model.getValue(),
        encoding: "utf8",
        expectedVersion: expectedVersion ?? tab.baseVersion,
      })) as { version: string };
      tab.baseVersion = result.version;
      this.#markDirty(path, false);
    } catch (error) {
      if (error instanceof TransportError && error.code === "VERSION_CONFLICT") {
        const details = error.details as { expected?: string; actual?: string } | undefined;
        this.#host.onConflict(path, details?.expected ?? tab.baseVersion, details?.actual ?? "");
        return;
      }
      this.#host.onError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Non-destructive conflict resolution entry point invoked by `main.ts`
   * after the user picks "Overwrite disk" in the conflict prompt. */
  async overwriteWithLocal(path: string, actualVersion: string): Promise<void> {
    await this.#save(path, actualVersion);
  }

  /** "Reload from disk (discard my changes)". */
  async reloadFromDisk(path: string): Promise<void> {
    const tab = this.#tabs.get(path);
    if (!tab) return;
    try {
      const result = (await this.#transport.call("workspace.read", { path, encoding: "utf8" })) as {
        content: string;
        version: string;
      };
      tab.model.setValue(result.content);
      tab.baseVersion = result.version;
      this.#markDirty(path, false);
    } catch (error) {
      this.#host.onError(error instanceof Error ? error.message : String(error));
    }
  }

  async #onExternalChange(path: string): Promise<void> {
    const tab = this.#tabs.get(path);
    if (!tab) return;
    if (tab.dirty) {
      // Passive signal only -- never auto-resolve a dirty file.
      this.#host.onDirtyChanged(path, true);
      return;
    }
    await this.reloadFromDisk(path);
  }

  #renderTabs(): void {
    this.#tabsBar.innerHTML = "";
    for (const tab of this.#tabs.values()) {
      const el = document.createElement("div");
      el.className = `tab${tab.path === this.#activePath ? " tab--active" : ""}${tab.dirty ? " tab--dirty" : ""}`;
      const label = document.createElement("span");
      label.textContent = tab.path.split("/").pop() ?? tab.path;
      label.title = tab.path;
      label.onclick = () => this.#activate(tab.path);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.textContent = "×";
      close.onclick = (event) => {
        event.stopPropagation();
        this.closeTab(tab.path);
      };
      el.appendChild(label);
      el.appendChild(close);
      this.#tabsBar.appendChild(el);
    }
  }
}

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}
