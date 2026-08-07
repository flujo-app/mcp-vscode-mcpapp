import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CoreEvents } from "../src/core/events.js";
import { McpVscodeError } from "../src/core/errors.js";
import { Workspace } from "../src/core/workspace.js";

test("workspace confines paths and supports conflict-safe writes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-workspace-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(root, new CoreEvents());
  await workspace.initialize();

  const first = await workspace.write({ path: "src/example.txt", content: "hello\nworld" });
  assert.equal(first.path, "src/example.txt");
  const read = await workspace.read("src/example.txt");
  assert.equal(read.content, "hello\nworld");
  assert.equal(read.version, first.version);

  await assert.rejects(
    workspace.write({ path: "src/example.txt", content: "lost update", expectedVersion: "incorrect" }),
    (error: unknown) => error instanceof McpVscodeError && error.code === "VERSION_CONFLICT",
  );
  await assert.rejects(
    workspace.resolve("../outside.txt", true),
    (error: unknown) => error instanceof McpVscodeError && error.code === "PATH_OUTSIDE_WORKSPACE",
  );
  await assert.rejects(
    workspace.delete(".", true),
    (error: unknown) => error instanceof McpVscodeError && error.code === "ROOT_DELETE_FORBIDDEN",
  );
});

test("workspace search escapes literal input and sees unsaved overlays", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-search-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(root, new CoreEvents());
  await workspace.initialize();
  await workspace.write({ path: "notes.txt", content: "price is $5.00\nplain" });

  const matches = await workspace.search({ query: "$5.00", regex: false });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.line, 1);

  await workspace.updateOverlay({
    path: "notes.txt",
    content: "unsaved buffer",
    dirty: true,
    documentVersion: 2,
  });
  assert.equal((await workspace.read("notes.txt")).content, "unsaved buffer");
  assert.deepEqual(workspace.overlays(), [{ path: "notes.txt", dirty: true, documentVersion: 2 }]);
  workspace.clearOverlay("notes.txt");
  assert.equal((await workspace.read("notes.txt")).content, "price is $5.00\nplain");
});

test("workspace listing skips lost+found on volume-root workspaces", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-ignores-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(root, new CoreEvents());
  await workspace.initialize();
  await mkdir(path.join(root, "lost+found"), { recursive: true });
  await writeFile(path.join(root, "lost+found", "orphan"), "junk");
  await workspace.write({ path: "keep.txt", content: "kept" });

  const entries = await workspace.list(".", true);
  assert.deepEqual(entries.map((entry) => entry.path), ["keep.txt"]);
});

test("watching a root with an unreadable directory does not crash the process", async (t) => {
  // chmod is a no-op on Windows, and root bypasses the permission bits entirely.
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("requires POSIX permissions and a non-root user");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-watch-"));
  const denied = path.join(root, "denied");
  await mkdir(denied, { recursive: true });
  await chmod(denied, 0o000);
  t.after(async () => {
    await chmod(denied, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const workspace = new Workspace(root, new CoreEvents());
  await workspace.initialize();
  await workspace.startWatching();
  // Give chokidar's initial walk time to reach the unreadable directory; the
  // regression was an uncaught EACCES emitted asynchronously after this point.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await workspace.close();
});
