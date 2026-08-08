// Native-tier file explorer: lazily expandable tree backed by `workspace.list`
// over the `/ui` transport (`fs_list`'s underlying implementation). Entries
// come back with workspace-root-relative `path`s (see `Workspace#list` in
// `src/core/workspace.ts`); this module only ever asks for one directory
// level at a time (`recursive:false`) and expands on click.
import type { UiClientTransport } from "./transport.js";

export interface WorkspaceEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
}

export interface ExplorerHost {
  onOpenFile(path: string): void;
}

const MAX_ENTRIES_PER_DIRECTORY = 2_000;

export class Explorer {
  readonly #root: HTMLElement;
  readonly #transport: UiClientTransport;
  readonly #host: ExplorerHost;
  readonly #expanded = new Map<string, HTMLUListElement>();

  constructor(root: HTMLElement, transport: UiClientTransport, host: ExplorerHost) {
    this.#root = root;
    this.#transport = transport;
    this.#host = host;
  }

  async refresh(): Promise<void> {
    this.#expanded.clear();
    this.#root.innerHTML = "";
    try {
      const entries = await this.#listDir(".");
      this.#root.appendChild(this.#renderList(entries));
    } catch (error) {
      const message = document.createElement("div");
      message.className = "explorer-error";
      message.textContent = error instanceof Error ? error.message : String(error);
      this.#root.appendChild(message);
    }
  }

  async #listDir(dirPath: string): Promise<WorkspaceEntry[]> {
    const result = (await this.#transport.call("workspace.list", {
      path: dirPath,
      recursive: false,
      maxEntries: MAX_ENTRIES_PER_DIRECTORY,
    })) as { entries: WorkspaceEntry[] };
    return sortEntries(result.entries ?? []);
  }

  #renderList(entries: WorkspaceEntry[]): HTMLUListElement {
    const ul = document.createElement("ul");
    ul.className = "tree";
    const truncated = entries.length >= MAX_ENTRIES_PER_DIRECTORY;
    for (const entry of truncated ? entries.slice(0, MAX_ENTRIES_PER_DIRECTORY) : entries) {
      ul.appendChild(this.#renderEntry(entry));
    }
    if (truncated) {
      const more = document.createElement("li");
      more.className = "tree-more";
      more.textContent = `…more (showing first ${MAX_ENTRIES_PER_DIRECTORY})`;
      ul.appendChild(more);
    }
    return ul;
  }

  #renderEntry(entry: WorkspaceEntry): HTMLLIElement {
    const li = document.createElement("li");
    const row = document.createElement("div");
    const name = entry.path.split("/").pop() ?? entry.path;
    row.className = `tree-row tree-row--${entry.type}`;
    row.textContent = name;
    row.title = entry.path;
    li.appendChild(row);

    if (entry.type === "directory") {
      row.classList.add("tree-row--expandable");
      row.onclick = () => void this.#toggleDirectory(entry.path, li, row);
    } else {
      row.onclick = () => this.#host.onOpenFile(entry.path);
    }
    return li;
  }

  async #toggleDirectory(dirPath: string, li: HTMLLIElement, row: HTMLDivElement): Promise<void> {
    const existing = this.#expanded.get(dirPath);
    if (existing) {
      existing.remove();
      this.#expanded.delete(dirPath);
      row.classList.remove("tree-row--open");
      return;
    }
    try {
      const entries = await this.#listDir(dirPath);
      const list = this.#renderList(entries);
      li.appendChild(list);
      this.#expanded.set(dirPath, list);
      row.classList.add("tree-row--open");
    } catch (error) {
      row.title = error instanceof Error ? error.message : String(error);
    }
  }
}

function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    const aIsDir = a.type === "directory";
    const bIsDir = b.type === "directory";
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.path.localeCompare(b.path, undefined, { sensitivity: "base", numeric: true });
  });
}
