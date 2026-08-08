// Native-tier editor: one Monaco model per open file (keyed by
// workspace-relative path), tabs kept alive across switches, disposed on tab
// close. The Monaco runtime is supplied by `loadUiAssets`, which is bundled
// into the same MCP App document so hosted clients need no sidecar asset URL.
import type * as monaco from "monaco-editor/editor/editor.api.js";
import type { UiClientTransport } from "./transport.js";
import { loadUiAssets } from "./assets-loader.js";
import { TransportError } from "./transport.js";
import { McpVscodeError } from "../core/errors.js";
import type { EditOperationInput, EditRangeInput } from "./edit-ops.js";
import { toMonacoEditOperations, toMonacoRange } from "./edit-ops.js";
import type { HostTokenMap, ThemeMode } from "./theme.js";
import { buildMonacoTheme } from "./theme.js";

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

/** Snapshot of the currently active file/selection, pushed (debounced) to
 * `app.updateModelContext()` by `main.ts` (plan §4.1). */
export interface ActiveEditorContext {
  path?: string;
  selection?: EditRangeInput;
  selectedText: string;
  dirty: boolean;
  openFiles: string[];
}

export interface EditorHost {
  onDirtyChanged(path: string, dirty: boolean): void;
  onConflict(path: string, expected: string, actual: string): void;
  onError(message: string): void;
  /** Fired whenever the active file, selection, dirty state, or open-tab
   * set changes. `main.ts` funnels this through a debouncer into
   * `app.updateModelContext()`. Optional so tests/fakes need not implement
   * it. */
  onActiveContextChanged?(context: ActiveEditorContext): void;
}

export class NativeEditor {
  readonly #container: HTMLElement;
  readonly #tabsBar: HTMLElement;
  readonly #transport: UiClientTransport;
  readonly #host: EditorHost;
  readonly #assetsUrl: string;
  readonly #tabs = new Map<string, OpenTab>();
  #activePath?: string;
  #monaco?: typeof monaco;
  #editor?: monaco.editor.IStandaloneCodeEditor;
  #unsubscribe?: () => void;
  #unsubscribeSelection?: () => void;

  constructor(container: HTMLElement, tabsBar: HTMLElement, transport: UiClientTransport, assetsUrl: string, host: EditorHost) {
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

    const selectionDisposable = this.#editor.onDidChangeCursorSelection(() => this.#pushContext());
    this.#unsubscribeSelection = () => selectionDisposable.dispose();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribeSelection?.();
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
    this.#pushContext();
  }

  /** Native surface adapter for the MCP `editor_state` tool -- see
   * `src/app/transport.ts#handle` registration in `main.ts`. Mirrors the
   * shape of the VS Code bridge's `editorState()` (`src/bridge-extension`)
   * closely enough that callers don't need to branch on `surface`. */
  async getState(): Promise<Record<string, unknown>> {
    const active = this.#activePath ? this.#describeTab(this.#activePath) : undefined;
    return {
      active,
      visible: active ? [active] : [],
      workspaceFolders: [],
      dirtyDocuments: [...this.#tabs.values()]
        .filter((tab) => tab.dirty)
        .map((tab) => ({ path: tab.path, version: tab.baseVersion })),
    };
  }

  /** Native surface adapter for `editor_open`. */
  async open(params: unknown): Promise<Record<string, unknown>> {
    const args = params as { path: string; line?: number; column?: number };
    await this.openFile(args.path);
    if (typeof args.line === "number" && this.#editor) {
      const position = { lineNumber: args.line, column: args.column ?? 1 };
      this.#editor.setPosition(position);
      this.#editor.revealPositionInCenterIfOutsideViewport(position);
      this.#pushContext();
    }
    return { path: args.path, languageId: languageFor(args.path) };
  }

  /** Native surface adapter for `editor_set_selection`. */
  async setSelection(params: unknown): Promise<Record<string, unknown>> {
    const args = params as EditRangeInput & { path: string };
    await this.openFile(args.path);
    if (!this.#editor) {
      throw new McpVscodeError("The native editor failed to mount", "INTERNAL_ERROR");
    }
    const range = toMonacoRange(args);
    this.#editor.setSelection(range);
    this.#editor.revealRangeInCenterIfOutsideViewport(range);
    this.#pushContext();
    return { selected: true, path: args.path };
  }

  /**
   * Native surface adapter for `editor_apply_edits`. Applies Monaco **edit
   * operations** (`model.pushEditOperations`), never a file rewrite, so
   * undo history and dirty state survive (epic #10 §7-A / Phase 3 §3.2).
   * Reuses the workspace SHA-256 version hash via `#save()` so a
   * concurrent on-disk change surfaces `VERSION_CONFLICT` as the same
   * conflict-resolution prompt `main.ts` already renders, rather than a
   * silently lost update.
   */
  async applyEdits(params: unknown): Promise<Record<string, unknown>> {
    const args = params as { path: string; edits: EditOperationInput[]; save?: boolean };
    await this.openFile(args.path);
    const tab = this.#tabs.get(args.path);
    if (!tab) {
      throw new McpVscodeError(`Failed to open "${args.path}" for editing`, "INTERNAL_ERROR");
    }
    const operations = toMonacoEditOperations(args.edits);
    tab.model.pushEditOperations([], operations, () => null);
    const shouldSave = args.save !== false;
    if (!shouldSave) {
      return { applied: true, saved: false, path: args.path, version: tab.baseVersion };
    }
    const outcome = await this.#save(args.path);
    return {
      applied: true,
      saved: outcome.saved,
      conflict: outcome.conflict ?? false,
      path: args.path,
      version: tab.baseVersion,
    };
  }

  /** Native surface adapter for `diagnostics_get`. Monaco's built-in
   * language workers (TS/JSON) populate `editor.getModelMarkers()`; there
   * is no external language server in the native tier, so this is
   * necessarily a narrower diagnostic set than the VS Code bridge's, but
   * it is never absent (an empty list, not an error). */
  async getDiagnostics(params: unknown): Promise<Record<string, unknown>> {
    const monacoModule = await this.#ensureMonaco();
    const args = (params as { path?: string } | undefined) ?? {};
    const describe = (tab: OpenTab): Record<string, unknown> => ({
      path: tab.path,
      values: monacoModule.editor.getModelMarkers({ resource: tab.model.uri }).map(markerDescriptor),
    });
    if (args.path) {
      const tab = this.#tabs.get(args.path);
      return { diagnostics: tab ? [describe(tab)] : [] };
    }
    return { diagnostics: [...this.#tabs.values()].map(describe) };
  }

  /** Applies a host-derived theme to the mounted Monaco instance (plan
   * §4.2). Called from `main.ts` on mount and on every
   * `app.onhostcontextchanged`. A no-op before `mount()` resolves. */
  applyTheme(tokens: HostTokenMap, mode: ThemeMode): void {
    if (!this.#monaco) return;
    const theme = buildMonacoTheme(tokens, mode, { resolve: resolveComputedColor });
    this.#monaco.editor.defineTheme("mcp-host", theme);
    this.#monaco.editor.setTheme("mcp-host");
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
    this.#pushContext();
  }

  #markDirty(path: string, dirty: boolean): void {
    const tab = this.#tabs.get(path);
    if (!tab || tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.#host.onDirtyChanged(path, dirty);
    this.#renderTabs();
    this.#pushContext();
  }

  async #saveActive(): Promise<void> {
    if (!this.#activePath) return;
    await this.#save(this.#activePath);
  }

  async #save(path: string, expectedVersion?: string): Promise<{ saved: boolean; conflict?: boolean }> {
    const tab = this.#tabs.get(path);
    if (!tab) return { saved: false };
    try {
      const result = (await this.#transport.call("workspace.write", {
        path,
        content: tab.model.getValue(),
        encoding: "utf8",
        expectedVersion: expectedVersion ?? tab.baseVersion,
      })) as { version: string };
      tab.baseVersion = result.version;
      this.#markDirty(path, false);
      return { saved: true };
    } catch (error) {
      if (error instanceof TransportError && error.code === "VERSION_CONFLICT") {
        const details = error.details as { expected?: string; actual?: string } | undefined;
        this.#host.onConflict(path, details?.expected ?? tab.baseVersion, details?.actual ?? "");
        return { saved: false, conflict: true };
      }
      this.#host.onError(error instanceof Error ? error.message : String(error));
      return { saved: false };
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

  #describeTab(path: string): Record<string, unknown> | undefined {
    const tab = this.#tabs.get(path);
    if (!tab) return undefined;
    const selection = this.#editor?.getSelection();
    return {
      path,
      version: tab.baseVersion,
      dirty: tab.dirty,
      selections: selection ? [selectionDescriptor(selection)] : [],
    };
  }

  #pushContext(): void {
    if (!this.#host.onActiveContextChanged) return;
    const path = this.#activePath;
    const tab = path ? this.#tabs.get(path) : undefined;
    const selection = this.#editor?.getSelection();
    const model = this.#editor?.getModel();
    this.#host.onActiveContextChanged({
      path,
      dirty: tab?.dirty ?? false,
      openFiles: [...this.#tabs.keys()],
      selection: selection ? selectionDescriptor(selection) : undefined,
      selectedText: selection && model ? model.getValueInRange(selection) : "",
    });
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

function selectionDescriptor(selection: monaco.Selection): EditRangeInput {
  return {
    startLine: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLine: selection.endLineNumber,
    endColumn: selection.endColumn,
  };
}

function markerDescriptor(marker: monaco.editor.IMarker): Record<string, unknown> {
  return {
    message: marker.message,
    severity: marker.severity,
    source: marker.source,
    code: typeof marker.code === "object" ? marker.code?.value : marker.code,
    range: {
      startLine: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
    },
  };
}

/** DOM-dependent colour resolver handed to `theme.ts#normalizeColor` for
 * host tokens it cannot parse itself (`oklch()`, `color-mix()`, named
 * colours, ...) -- resolves via a throwaway, never-attached element so it
 * never triggers layout (plan §4.2 risk R5: `normalizeColor` itself never
 * throws, but the browser's `getComputedStyle` needs *some* element). */
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

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}
