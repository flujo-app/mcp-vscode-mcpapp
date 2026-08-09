import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverChromiumExecutable } from "../src/runtime/chromium-discovery.js";

test("Chromium discovery honors an explicit executable override", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-browser-discovery-"));
  const executable = path.join(root, process.platform === "win32" ? "browser.exe" : "browser");
  await writeFile(executable, "test browser");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.equal(await discoverChromiumExecutable({ override: executable }), executable);
});

test("Chromium discovery fails honestly for a missing explicit executable", async () => {
  const missing = path.join(os.tmpdir(), `missing-browser-${Date.now()}`, "browser");
  assert.equal(await discoverChromiumExecutable({ override: missing }), undefined);
});

test("Chromium discovery searches PATH without executing candidate programs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-browser-path-"));
  const name = process.platform === "win32" ? "chrome.exe" : "chromium";
  const executable = path.join(root, name);
  await writeFile(executable, "test browser");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const found = await discoverChromiumExecutable({
    platform: process.platform,
    env: { PATH: root },
  });
  assert.equal(found, executable);
});
