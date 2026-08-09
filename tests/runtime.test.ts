import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  platformRuntimePackage,
  redactOpenVscodeLogLine,
  resolveOpenVscodeLaunch,
  resolvePlatformRuntimeRoot,
} from "../src/runtime/openvscode.js";

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

test("Linux launches the server through its shell entrypoint", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(path.join(root, "bin", "openvscode-server"), "#!/bin/sh\n");

  const launch = await resolveOpenVscodeLaunch([root], "linux");

  assert.deepEqual(launch, {
    executable: path.join(root, "bin", "openvscode-server"),
    prefixArgs: [],
    shell: false,
  });
});

test("platform runtime package names follow the published npm layout", () => {
  assert.equal(platformRuntimePackage("win32", "x64"), "@mario.andreschak/mcp-vscode-win32-x64");
  assert.equal(platformRuntimePackage("linux", "x64"), "@mario.andreschak/mcp-vscode-linux-x64");
  assert.equal(platformRuntimePackage("linux", "arm64"), "@mario.andreschak/mcp-vscode-linux-arm64");
});

test("an uninstalled platform runtime package resolves to undefined instead of throwing", () => {
  // Unsupported hosts (for example darwin) must fall through to the remaining
  // search roots rather than crashing startup.
  assert.equal(resolvePlatformRuntimeRoot("darwin", "arm64"), undefined);
  assert.equal(resolvePlatformRuntimeRoot("linux", "riscv64"), undefined);
});

test("OpenVSCode log lines never expose the random workbench route capability", () => {
  const secretPath = "/ide/Qd1bVpyL95OSBErRGgoYIH_fEam-dg6X";
  const line = `Web UI available at http://127.0.0.1:3000${secretPath}/?folder=/workspace`;

  const redacted = redactOpenVscodeLogLine(line, secretPath);

  assert.equal(
    redacted,
    "Web UI available at http://127.0.0.1:3000/ide/<app-only>/?folder=/workspace",
  );
  assert.equal(redacted.includes("Qd1bVpyL95OSBErRGgoYIH_fEam-dg6X"), false);
});
