import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  lstat,
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

// `lost+found` exists at the root of every ext4 volume and is root-owned 0700.
// When the workspace root is a mounted volume, descending into it raises EACCES
// for any non-root process, so it is skipped alongside the usual noise.
const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  ".mcp-vscode",
  "lost+found",
]);

export interface WorkspaceEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  modifiedAt?: string;
  error?: string;
}
export interface WorkspaceSkipped {
  path: string;
  operation: "metadata" | "list" | "read";
  code: string;
}
export interface WorkspaceListing {
  entries: WorkspaceEntry[];
  skipped: WorkspaceSkipped[];
  truncated: boolean;
}
export interface WorkspaceMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}
export interface WorkspaceSearchOptions {
  query: string;
  path?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}
export interface WorkspaceSearchResult {
  matches: WorkspaceMatch[];
  skipped: WorkspaceSkipped[];
  truncated: boolean;
}

export class Workspace {
  readonly root: string;
  readonly #events: CoreEvents;
  #rootReal = "";
  #watcher?: FSWatcher;
  readonly #overlays = new Map<
    string,
    { content: string; dirty: boolean; documentVersion: number }
  >();

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
    this.#watcher = chokidar.watch(this.#rootReal, {
      // Native ReadDirectoryChangesW can abort Node24 in libuv during rapid teardown.
      // Polling avoids that process-level failure and does not traverse external links.
      usePolling: process.platform === "win32",
      interval: 250,
      binaryInterval: 500,
      followSymlinks: false,
      ignoreInitial: true,
      // Unreadable subdirectories must never take the process down: chokidar
      // rethrows EACCES/EPERM as an unhandled `error` event otherwise.
      ignorePermissionErrors: true,
      ignored: (candidate) => {
        const relative = path.relative(this.#rootReal, candidate);
        return relative
          .split(path.sep)
          .some((part) => DEFAULT_IGNORES.has(part));
      },
    });
    const emit = (kind: string, candidate: string) => {
      this.#events.emit("workspace.changed", {
        kind,
        path: path.relative(this.#rootReal, candidate).split(path.sep).join("/") || ".",
      });
    };
    this.#watcher.on("add", (value) => emit("created", value));
    this.#watcher.on("change", (value) => emit("changed", value));
    this.#watcher.on("unlink", (value) => emit("deleted", value));
    this.#watcher.on("addDir", (value) => emit("directory-created", value));
    this.#watcher.on("unlinkDir", (value) => emit("directory-deleted", value));
    // An FSWatcher is an EventEmitter: without this listener a watch failure is
    // rethrown as an uncaught exception and kills the server at startup.
    this.#watcher.on("error", (error) => {
      const cause = error as NodeJS.ErrnoException;
      this.#events.emit("workspace.watch-error", {
        message: cause.message ?? String(error),
        ...(cause.code ? { code: cause.code } : {}),
        ...(cause.path ? { path: this.relative(cause.path) } : {}),
      });
    });
  }

  async close(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = undefined;
  }

  relative(absolutePath: string): string {
    return (
      path.relative(this.root, absolutePath).split(path.sep).join("/") || "."
    );
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
          if ((parentError as NodeJS.ErrnoException).code !== "ENOENT")
            throw parentError;
          parent = path.dirname(parent);
        }
      }
      throw new McpVscodeError(
        "Unable to resolve a safe parent directory",
        "INVALID_PATH",
      );
    }
  }

  async list(
    userPath = ".",
    recursive = false,
    maxEntries = 2_000,
  ): Promise<WorkspaceEntry[]> {
    return (await this.listDetailed(userPath, recursive, maxEntries)).entries;
  }

  async listDetailed(
    userPath = ".",
    recursive = false,
    maxEntries = 2_000,
  ): Promise<WorkspaceListing> {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 20_000)
      throw new McpVscodeError("Invalid listing limit", "INVALID_LIST_LIMIT");
    const start = await this.resolve(userPath);
    const result: WorkspaceListing = {
      entries: [],
      skipped: [],
      truncated: false,
    };
    const recoverable = new Set([
      "ENOENT",
      "EACCES",
      "EPERM",
      "ELOOP",
      "ENOTDIR",
      "PATH_OUTSIDE_WORKSPACE",
    ]);
    const skip = (
      absolute: string,
      operation: WorkspaceSkipped["operation"],
      error: unknown,
    ): void => {
      const code = (error as NodeJS.ErrnoException).code ?? "READ_FAILED";
      if (!recoverable.has(code)) throw error;
      result.skipped.push({ path: this.relative(absolute), operation, code });
    };
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        // Recheck the confined path before descending; a directory may have changed since lstat.
        if (directory !== start && (await lstat(directory)).isSymbolicLink()) {
          result.skipped.push({
            path: this.relative(directory),
            operation: "list",
            code: "SYMLINK_NOT_FOLLOWED",
          });
          return;
        }
        await this.resolve(this.relative(directory));
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        skip(directory, "list", error);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (DEFAULT_IGNORES.has(entry.name)) continue;
        if (result.entries.length >= maxEntries) {
          result.truncated = true;
          if (!result.skipped.some((item) => item.code === "MAX_ENTRIES"))
            result.skipped.push({
              path: this.relative(directory),
              operation: "list",
              code: "MAX_ENTRIES",
            });
          return;
        }
        const absolute = path.join(directory, entry.name);
        let info;
        try {
          info = await lstat(absolute);
        } catch (error) {
          skip(absolute, "metadata", error);
          result.entries.push({
            path: this.relative(absolute),
            type: entry.isSymbolicLink()
              ? "symlink"
              : entry.isDirectory()
                ? "directory"
                : entry.isFile()
                  ? "file"
                  : "other",
            error: (error as NodeJS.ErrnoException).code ?? "READ_FAILED",
          });
          continue;
        }
        result.entries.push({
          path: this.relative(absolute),
          type: info.isSymbolicLink()
            ? "symlink"
            : info.isDirectory()
              ? "directory"
              : info.isFile()
                ? "file"
                : "other",
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
        if (recursive && info.isDirectory()) await visit(absolute);
      }
    };
    const info = await stat(start);
    if (!info.isDirectory())
      throw new McpVscodeError(
        `${userPath} is not a directory`,
        "NOT_A_DIRECTORY",
      );
    await visit(start);
    return result;
  }

  async read(
    userPath: string,
    encoding: "utf8" | "base64" = "utf8",
  ): Promise<{
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
        content: overlay.content.replace(/^\uFEFF/, ""),
        encoding,
        size: data.length,
        version: createHash("sha256").update(data).digest("hex"),
      };
    }
    const data = await readFile(absolute);
    return {
      path: relativePath,
      content:
        encoding === "utf8"
          ? data.toString("utf8").replace(/^\uFEFF/, "")
          : data.toString("base64"),
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

  async delete(
    userPath: string,
    recursive = false,
  ): Promise<{ path: string; deleted: true }> {
    const absolute = await this.resolve(userPath);
    if (absolute === this.root) {
      throw new McpVscodeError(
        "Refusing to delete the workspace root",
        "ROOT_DELETE_FORBIDDEN",
      );
    }
    const info = await stat(absolute);
    if (info.isDirectory() && !recursive) {
      throw new McpVscodeError(
        "Directory deletion requires recursive=true",
        "RECURSIVE_REQUIRED",
      );
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
    const result = {
      from: this.relative(source),
      to: this.relative(destination),
    };
    this.#events.emit("workspace.moved", result);
    return result;
  }

  async search(options: WorkspaceSearchOptions): Promise<WorkspaceMatch[]> {
    return (await this.searchDetailed(options)).matches;
  }

  async searchDetailed(
    options: WorkspaceSearchOptions,
  ): Promise<WorkspaceSearchResult> {
    const maxResults = Math.min(options.maxResults ?? 200, 2_000);
    if (!Number.isInteger(maxResults) || maxResults < 1)
      throw new McpVscodeError("Invalid search limit", "INVALID_SEARCH_LIMIT");
    const files = await this.listDetailed(options.path ?? ".", true, 20_000);
    const flags = options.caseSensitive ? "g" : "gi";
    const expression = options.regex
      ? undefined
      : new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const matcher = options.regex
      ? regexMatcher(options.query, flags)
      : undefined;
    try {
      if (matcher) await matcher.match("", 0);
      const result: WorkspaceSearchResult = {
        matches: [],
        skipped: [...files.skipped],
        truncated: files.truncated,
      };
      for (const entry of files.entries) {
        if (entry.type !== "file" || entry.error) continue;
        if ((entry.size ?? 0) > 2_000_000) {
          result.skipped.push({
            path: entry.path,
            operation: "read",
            code: "FILE_TOO_LARGE",
          });
          continue;
        }
        let content: string;
        try {
          content = (await this.read(entry.path)).content;
        } catch (error) {
          result.skipped.push({
            path: entry.path,
            operation: "read",
            code: (error as NodeJS.ErrnoException).code ?? "READ_FAILED",
          });
          continue;
        }
        if (matcher) {
          const batch = await matcher.match(
            content,
            maxResults - result.matches.length,
          );
          result.matches.push(
            ...batch.matches.map((match) => ({ ...match, path: entry.path })),
          );
          if (batch.truncated) {
            result.truncated = true;
            return result;
          }
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index] ?? "";
          expression!.lastIndex = 0;
          const match = expression!.exec(line);
          if (!match) continue;
          if (result.matches.length >= maxResults) {
            result.truncated = true;
            return result;
          }
          result.matches.push({
            path: entry.path,
            line: index + 1,
            column: match.index + 1,
            preview: line.slice(0, 500),
          });
        }
      }
      return result;
    } finally {
      await matcher?.close();
    }
  }

  #assertLexicallyInside(candidate: string): void {
    const relative = path.relative(this.root, candidate);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    ) {
      throw new McpVscodeError(
        "Path escapes the workspace root",
        "PATH_OUTSIDE_WORKSPACE",
      );
    }
  }

  #assertReallyInside(candidate: string): void {
    const relative = path.relative(this.#rootReal, candidate);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    ) {
      throw new McpVscodeError(
        "Resolved path escapes the workspace root",
        "PATH_OUTSIDE_WORKSPACE",
      );
    }
  }
}

const REGEX_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
let expression;
try { expression = new RegExp(workerData.query, workerData.flags); }
catch { parentPort.postMessage({ error: "INVALID_SEARCH_REGEX" }); }
parentPort.on("message", ({ content, maxResults }) => {
  if (!expression) return;
  const matches = [];
  const lines = content.split(/\\r?\\n/);
  for (let index = 0; index < lines.length; index++) {
    expression.lastIndex = 0;
    const match = expression.exec(lines[index]);
    if (!match) continue;
    if (matches.length >= maxResults) { parentPort.postMessage({ matches, truncated: true }); return; }
    matches.push({ line: index + 1, column: match.index + 1, preview: lines[index].slice(0, 500) });
  }
  parentPort.postMessage({ matches, truncated: false });
});
`;

function regexMatcher(query: string, flags: string) {
  const worker = new Worker(REGEX_WORKER, {
    eval: true,
    workerData: { query, flags },
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
  });
  const deadline = Date.now() + 10_000;
  type Batch = {
    matches: Array<Omit<WorkspaceMatch, "path">>;
    truncated: boolean;
  };
  let pending:
    | { resolve(value: Batch): void; reject(error: unknown): void }
    | undefined;
  let failure: McpVscodeError | undefined;
  const fail = (code: string) => {
    failure = new McpVscodeError(
      code === "INVALID_SEARCH_REGEX"
        ? "Invalid search regular expression"
        : "Regular expression search exceeded its execution or memory limit",
      code,
    );
    pending?.reject(failure);
  };
  worker.on("error", () => fail("SEARCH_REGEX_LIMIT"));
  worker.on("exit", (code) => {
    if (code && pending) fail("SEARCH_REGEX_LIMIT");
  });
  worker.on("message", (message: Batch & { error?: string }) => {
    if (message.error) fail(message.error);
    else pending?.resolve(message);
  });
  return {
    async match(content: string, maxResults: number): Promise<Batch> {
      if (failure) throw failure;
      const remaining = Math.min(1000, deadline - Date.now());
      if (remaining <= 0) {
        fail("SEARCH_REGEX_LIMIT");
        throw failure;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<Batch>((resolve, reject) => {
          pending = { resolve, reject };
          timer = setTimeout(() => {
            fail("SEARCH_REGEX_LIMIT");
            void worker.terminate();
          }, remaining);
          worker.postMessage({ content, maxResults });
        });
      } finally {
        clearTimeout(timer);
        pending = undefined;
      }
    },
    async close() {
      await worker.terminate();
    },
  };
}
