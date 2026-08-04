import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOpenVscodeLaunch } from "../src/runtime/openvscode.js";

test("Windows launches the server directly with bundled Node.js", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "out"), { recursive: true });
  await writeFile(path.join(root, "node.exe"), "");
  await writeFile(path.join(root, "out", "server-main.js"), "");

  const launch = await resolveOpenVscodeLaunch([root], "win32");

  assert.deepEqual(launch, {
    executable: path.join(root, "node.exe"),
    prefixArgs: [path.join(root, "out", "server-main.js")],
    shell: false,
  });
});

test("Windows retains compatibility with a batch-only OpenVSCode layout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(path.join(root, "bin", "openvscode-server.cmd"), "@echo off\r\n");

  const launch = await resolveOpenVscodeLaunch([root], "win32");

  assert.deepEqual(launch, {
    executable: path.join(root, "bin", "openvscode-server.cmd"),
    prefixArgs: [],
    shell: true,
  });
});
