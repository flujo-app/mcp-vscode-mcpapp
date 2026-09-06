import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CoreEvents } from "../src/core/events.js";
import { Workspace } from "../src/core/workspace.js";

async function setup(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-resilient-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(root, new CoreEvents());
  await workspace.initialize();
  return { root, workspace };
}

test("listing uses each symlink's metadata and search retains readable siblings", async (t) => {
  const { root, workspace } = await setup(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.txt"), "outside-needle");
  await workspace.write({ path: "readable.txt", content: "inside-needle" });
  try {
    await symlink(
      outside,
      path.join(root, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      path.join(root, "missing"),
      path.join(root, "dangling"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      t.skip("Windows symlink privileges unavailable");
      return;
    }
    throw error;
  }
  const listing = await workspace.listDetailed(".", true);
  for (const name of ["outside", "dangling"]) {
    const entry = listing.entries.find((item) => item.path === name);
    const actual = await lstat(path.join(root, name));
    assert.equal(entry?.type, "symlink");
    assert.equal(entry?.size, actual.size);
    assert.equal(entry?.modifiedAt, actual.mtime.toISOString());
  }
  assert.equal(
    listing.entries.some((item) => item.path.includes("secret.txt")),
    false,
  );
  const search = await workspace.searchDetailed({ query: "needle" });
  assert.deepEqual(
    search.matches.map((match) => match.path),
    ["readable.txt"],
  );
  await assert.rejects(workspace.read("outside/secret.txt"), {
    code: "PATH_OUTSIDE_WORKSPACE",
  });
});

test("unreadable directories and per-entry metadata errors are reported with partial results", async (t) => {
  if (process.platform === "win32") {
    t.skip("requires POSIX directory permissions");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-permissions-"));
  const workspace = new Workspace(root, new CoreEvents());
  await workspace.initialize();
  await chmod(root, 0o755);
  const denied = path.join(root, "denied");
  const noExecute = path.join(root, "no-execute");
  await mkdir(denied);
  await mkdir(noExecute);
  await writeFile(path.join(noExecute, "hidden.txt"), "needle");
  await workspace.write({ path: "readable.txt", content: "needle" });
  await chmod(denied, 0o000);
  await chmod(noExecute, 0o444);
  t.after(async () => {
    await chmod(denied, 0o700).catch(() => {});
    await chmod(noExecute, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const code =
    "import {Workspace} from " +
    JSON.stringify(new URL("../src/core/workspace.ts", import.meta.url).href) +
    ";import {CoreEvents} from " +
    JSON.stringify(new URL("../src/core/events.ts", import.meta.url).href) +
    ";const w=new Workspace(process.argv[1],new CoreEvents());await w.initialize();console.log(JSON.stringify({list:await w.listDetailed('.',true),search:await w.searchDetailed({query:'needle'})}));";
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code, root],
    {
      cwd: process.cwd(),
      timeout: 10_000,
      ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
    },
  );
  const report = JSON.parse(result.stdout);
  assert.ok(
    report.list.skipped.some(
      (item: { path: string; code: string }) =>
        item.path === "denied" && item.code === "EACCES",
    ),
  );
  assert.ok(
    report.list.entries.some(
      (item: { path: string; error: string }) =>
        item.path === "no-execute/hidden.txt" && item.error === "EACCES",
    ),
  );
  assert.deepEqual(
    report.search.matches.map((item: { path: string }) => item.path),
    ["readable.txt"],
  );
  assert.ok(report.search.skipped.length >= 2);
});

test("UTF-8 reads strip a BOM without changing raw byte versions or base64", async (t) => {
  const { root, workspace } = await setup(t);
  const data = Buffer.from("\uFEFF—✓😀", "utf8");
  await writeFile(path.join(root, "bom.txt"), data);
  const read = await workspace.read("bom.txt");
  assert.equal(read.content, "—✓😀");
  assert.equal(read.size, data.length);
  assert.equal(read.version, createHash("sha256").update(data).digest("hex"));
  assert.equal(
    (await workspace.read("bom.txt", "base64")).content,
    data.toString("base64"),
  );
  await workspace.write({
    path: "bom.txt",
    content: "updated",
    expectedVersion: read.version,
  });
  assert.equal(await readFile(path.join(root, "bom.txt"), "utf8"), "updated");
  await workspace.updateOverlay({
    path: "bom.txt",
    content: "\uFEFFoverlay",
    dirty: true,
    documentVersion: 1,
  });
  assert.equal((await workspace.read("bom.txt")).content, "overlay");
});

test("reports listing/search truncation and accepts confined dot-prefixed names", async (t) => {
  const { workspace } = await setup(t);
  await workspace.write({ path: "..notes/a.txt", content: "needle\nneedle" });
  await workspace.write({ path: "b.txt", content: "needle" });
  const list = await workspace.listDetailed(".", true, 1);
  assert.equal(list.truncated, true);
  assert.ok(list.skipped.some((item) => item.code === "MAX_ENTRIES"));
  const search = await workspace.searchDetailed({
    query: "needle",
    maxResults: 1,
  });
  assert.equal(search.matches.length, 1);
  assert.equal(search.truncated, true);
});

test("pathological regex runs off-thread, times out, and leaves later searches usable", async (t) => {
  const { workspace } = await setup(t);
  await workspace.write({
    path: "input.txt",
    content: "a".repeat(100_000) + "!",
  });
  let ticks = 0;
  const interval = setInterval(() => ticks++, 10);
  const started = Date.now();
  try {
    await assert.rejects(
      workspace.searchDetailed({ query: "(a+)+$", regex: true }),
      { code: "SEARCH_REGEX_LIMIT" },
    );
  } finally {
    clearInterval(interval);
  }
  assert.ok(Date.now() - started < 4000);
  assert.ok(ticks > 5, "main thread remains responsive");
  assert.equal((await workspace.search({ query: "!" })).length, 1);
  await assert.rejects(workspace.search({ query: "[", regex: true }), {
    code: "INVALID_SEARCH_REGEX",
  });
  assert.equal(
    (await workspace.search({ query: "^a+", regex: true })).length,
    1,
  );
});
