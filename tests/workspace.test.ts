import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
