import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VscodeCore } from "../src/core/core.js";
import { Gateway } from "../src/http/gateway.js";
import { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

const runtimeRoot = process.env.MCP_VSCODE_REAL_RUNTIME_ROOT;

test("native OpenVSCode serves the workbench and connects the MCP bridge", {
  skip: runtimeRoot ? false : "Set MCP_VSCODE_REAL_RUNTIME_ROOT to run the native runtime test",
  timeout: 60_000,
}, async (t) => {
  assert.ok(runtimeRoot);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-real-runtime-"));
  await writeFile(path.join(workspace, "hello.txt"), "OpenVSCode on Windows\n");

  const core = new VscodeCore(workspace);
  await core.initialize();
  const runtime = new OpenVscodeRuntime({
    core,
    workspaceRoot: workspace,
    stateRoot: path.join(workspace, ".state"),
    openVscodeRoot: path.resolve(runtimeRoot),
  });
  const gateway = new Gateway({
    core,
    runtime,
    host: "127.0.0.1",
    port: 0,
    appHtmlPath: path.resolve("dist/app.html"),
  });

  t.after(async () => {
    runtime.close();
    await core.close();
    await gateway.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const address = await gateway.start();
  const status = await runtime.start({ gatewayOrigin: address.origin, bridgeUrl: gateway.localBridgeUrl });
  assert.equal(status.state, "ready", status.error ?? status.logs.join("\n"));
  assert.ok(status.browserUrl);

  const workbench = await fetch(status.browserUrl);
  assert.equal(workbench.status, 200);
  assert.match(await workbench.text(), /workbench|OpenVSCode/i);

  await waitUntil(() => core.bridge.status().connected, 30_000);
  const result = await core.bridge.call<{ commands: string[] }>("commands.list", {});
  assert.ok(Array.isArray(result.commands));
  assert.ok(result.commands.length > 0);
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The OpenVSCode bridge did not connect before the timeout");
}
