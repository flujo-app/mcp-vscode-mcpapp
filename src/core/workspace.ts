import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { CoreEvents } from "./events.js";
import { McpVscodeError } from "./errors.js";

const DEFAULT_IGNORES = new Set([".git", "node_modules", ".mcp-vscode"]);

export interface WorkspaceEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
}

export class Workspace {
  readonly root: string;
  readonly #events: CoreEvents;
  #rootReal = "";
  #watcher?: FSWatcher;
  readonly #overlays = new Map<string, { content: string; dirty: boolean; documentVersion: number }>();

  constructor(root: string, events: CoreEvents) {
    this.root = path.resolve(root);
    this.#events = events;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.#rootReal = await realpath(this.root);
  }

  async startWatching(): Promise<void> {
    if (this.#watcher) return;
    this.#watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      ignored: (candidate) => {
        const relative = path.relative(this.root, candidate);
        return relative.split(path.sep).some((part) => DEFAULT_IGNORES.has(part));
      },
    });
    const emit = (kind: string, candidate: string) => {
      this.#events.emit("workspace.changed", {
        kind,
        path: this.relative(candidate),
      });
    };
    this.#watcher.on("add", (value) => emit("created", value));
    this.#watcher.on("change", (value) => emit("changed", value));
    this.#watcher.on("unlink", (value) => emit("deleted", value));
    this.#watcher.on("addDir", (value) => emit("directory-created", value));
    this.#watcher.on("unlinkDir", (value) => emit("directory-deleted", value));
  }

  async close(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = undefined;
  }

  relative(absolutePath: string): string {
    return path.relative(this.root, absolutePath).split(path.sep).join("/") || ".";
  }

  async resolve(userPath = ".", allowMissing = false): Promise<string> {
    if (userPath.includes("\0")) {
      throw new McpVscodeError("Path contains a NUL byte", "INVALID_PATH");
    }
    const candidate = path.resolve(this.root, userPath);
    this.#assertLexicallyInside(candidate);
    try {
      const actual = await realpath(candidate);
      this.#assertReallyInside(actual);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!allowMissing || code !== "ENOENT") throw error;
      let parent = path.dirname(candidate);
      while (parent !== path.dirname(parent)) {
        try {
          const actualParent = await realpath(parent);
          this.#assertReallyInside(actualParent);
          return candidate;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
          parent = path.dirname(parent);
        }
      }
      throw new McpVscodeError("Unable to resolve a safe parent directory", "INVALID_PATH");
    }
  }

  async list(userPath = ".", recursive = false, maxEntries = 2_000): Promise<WorkspaceEntry[]> {
    const start = await this.resolve(userPath);
    const result: WorkspaceEntry[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (DEFAULT_IGNORES.has(entry.name)) continue;
        if (result.length >= maxEntries) return;
        const absolute = path.join(directory, entry.name);
        const info = await stat(absolute);
        result.push({
          path: this.relative(absolute),
          type: entry.isFile()
            ? "file"
            : entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
        if (recursive && entry.isDirectory()) await visit(absolute);
      }
    };
    const info = await stat(start);
    if (!info.isDirectory()) {
      throw new McpVscodeError(`${userPath} is not a directory`, "NOT_A_DIRECTORY");
    }
    await visit(start);
    return result;
  }

  async read(userPath: string, encoding: "utf8" | "base64" = "utf8"): Promise<{
    path: string;
    content: string;
    encoding: "utf8" | "base64";
    size: number;
    version: string;
  }> {
    const absolute = await this.resolve(userPath);
    const relativePath = this.relative(absolute);
    const overlay = this.#overlays.get(relativePath);
    if (overlay && encoding === "utf8") {
      const data = Buffer.from(overlay.content, "utf8");
      return {
        path: relativePath,
        content: overlay.content,
        encoding,
        size: data.length,
        version: createHash("sha256").update(data).digest("hex"),
      };
    }
    const data = await readFile(absolute);
    return {
      path: relativePath,
      content: data.toString(encoding),
      encoding,
      size: data.length,
      version: createHash("sha256").update(data).digest("hex"),
    };
  }

  async updateOverlay(options: {
    path: string;
    content: string;
    dirty: boolean;
    documentVersion: number;
  }): Promise<void> {
    const absolute = await this.resolve(options.path, true);
    this.#overlays.set(this.relative(absolute), {
      content: options.content,
      dirty: options.dirty,
      documentVersion: options.documentVersion,
    });
  }

  clearOverlay(userPath: string): void {
    const absolute = path.resolve(this.root, userPath);
    this.#assertLexicallyInside(absolute);
    this.#overlays.delete(this.relative(absolute));
  }

  overlays(): Array<{ path: string; dirty: boolean; documentVersion: number }> {
    return [...this.#overlays.entries()].map(([overlayPath, value]) => ({
      path: overlayPath,
      dirty: value.dirty,
      documentVersion: value.documentVersion,
    }));
  }

  async write(options: {
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    expectedVersion?: string;
    createParents?: boolean;
  }): Promise<{ path: string; size: number; version: string }> {
    const absolute = await this.resolve(options.path, true);
    if (options.expectedVersion) {
      const current = await this.read(options.path);
      if (current.version !== options.expectedVersion) {
        throw new McpVscodeError(
          "File changed since it was read",
          "VERSION_CONFLICT",
          { expected: options.expectedVersion, actual: current.version },
        );
      }
    }
    if (options.createParents ?? true) {
      await mkdir(path.dirname(absolute), { recursive: true });
    }
    const data = Buffer.from(options.content, options.encoding ?? "utf8");
    await writeFile(absolute, data);
    const version = createHash("sha256").update(data).digest("hex");
    this.#events.emit("workspace.written", {
      path: this.relative(absolute),
      size: data.length,
      version,
    });
    return { path: this.relative(absolute), size: data.length, version };
  }

  async delete(userPath: string, recursive = false): Promise<{ path: string; deleted: true }> {
    const absolute = await this.resolve(userPath);
    if (absolute === this.root) {
      throw new McpVscodeError("Refusing to delete the workspace root", "ROOT_DELETE_FORBIDDEN");
    }
    const info = await stat(absolute);
    if (info.isDirectory() && !recursive) {
      throw new McpVscodeError("Directory deletion requires recursive=true", "RECURSIVE_REQUIRED");
    }
    await rm(absolute, { recursive, force: false });
    this.#events.emit("workspace.deleted", { path: this.relative(absolute) });
    return { path: this.relative(absolute), deleted: true };
  }

  async move(from: string, to: string): Promise<{ from: string; to: string }> {
    const source = await this.resolve(from);
    const destination = await this.resolve(to, true);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    const result = { from: this.relative(source), to: this.relative(destination) };
    this.#events.emit("workspace.moved", result);
    return result;
  }

  async search(options: {
    query: string;
    path?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    maxResults?: number;
  }): Promise<Array<{ path: string; line: number; column: number; preview: string }>> {
    const maxResults = Math.min(options.maxResults ?? 200, 2_000);
    const files = await this.list(options.path ?? ".", true, 20_000);
    const flags = options.caseSensitive ? "g" : "gi";
    const expression = options.regex
      ? new RegExp(options.query, flags)
      : new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const results: Array<{ path: string; line: number; column: number; preview: string }> = [];
    for (const entry of files) {
      if (entry.type !== "file" || entry.size > 2_000_000) continue;
      let content: string;
      try {
        content = (await this.read(entry.path)).content;
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        expression.lastIndex = 0;
        const match = expression.exec(line);
        if (!match) continue;
        results.push({
          path: entry.path,
          line: index + 1,
          column: match.index + 1,
          preview: line.slice(0, 500),
        });
        if (results.length >= maxResults) return results;
      }
    }
    return results;
  }

  #assertLexicallyInside(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new McpVscodeError("Path escapes the workspace root", "PATH_OUTSIDE_WORKSPACE");
    }
  }

  #assertReallyInside(candidate: string): void {
    const relative = path.relative(this.#rootReal, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new McpVscodeError("Resolved path escapes the workspace root", "PATH_OUTSIDE_WORKSPACE");
    }
  }
}
