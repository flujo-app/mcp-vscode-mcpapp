import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VscodeCore } from "../src/core/core.js";
import { Gateway } from "../src/http/gateway.js";
import { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

const runtimeRoot = process.env.MCP_VSCODE_REAL_RUNTIME_ROOT;

test("real OpenVSCode serves the workbench with the MCP bridge installed", {
  skip: runtimeRoot ? false : "Set MCP_VSCODE_REAL_RUNTIME_ROOT to run the real runtime test",
  timeout: 60_000,
}, async (t) => {
  assert.ok(runtimeRoot);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-real-runtime-"));
  await writeFile(path.join(workspace, "hello.txt"), "OpenVSCode on Windows\n");
  const stateRoot = path.join(workspace, ".state");

  const core = new VscodeCore(workspace);
  await core.initialize();
  const runtime = new OpenVscodeRuntime({
    core,
    workspaceRoot: workspace,
    stateRoot,
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

  const extensions = await readdir(path.join(stateRoot, "extensions"), { withFileTypes: true });
  const bridgeDirectory = extensions.find((entry) => entry.isDirectory() && entry.name.startsWith("flujo.mcp-vscode-"));
  assert.ok(bridgeDirectory, "The MCP bridge extension was not installed into the real runtime");
  const bridgeManifest = JSON.parse(await readFile(
    path.join(stateRoot, "extensions", bridgeDirectory.name, "package.json"),
    "utf8",
  )) as { publisher?: string; name?: string; main?: string };
  assert.equal(bridgeManifest.publisher, "flujo");
  assert.equal(bridgeManifest.name, "mcp-vscode");
  assert.equal(bridgeManifest.main, "./extension.cjs");
  await access(path.join(stateRoot, "extensions", bridgeDirectory.name, "extension.cjs"));
});
