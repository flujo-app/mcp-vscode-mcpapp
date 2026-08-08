import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VscodeCore } from "../src/core/core.js";
import { Gateway } from "../src/http/gateway.js";
import { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

async function startGateway(assetsRoot: string) {
  process.env.MCP_VSCODE_DISABLE_PTY = "1";
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-assets-workspace-"));
  const core = new VscodeCore(workspace);
  await core.initialize();
  const runtime = new OpenVscodeRuntime({ core, workspaceRoot: workspace });
  const gateway = new Gateway({
    core,
    runtime,
    host: "127.0.0.1",
    port: 0,
    appHtmlPath: path.resolve("dist/app.html"),
    assetsRoot,
  });
  const started = await gateway.start();
  return {
    core,
    runtime,
    gateway,
    started,
    workspace,
    async close() {
      runtime.close();
      await core.close();
      await gateway.close();
      await rm(workspace, { recursive: true, force: true });
      delete process.env.MCP_VSCODE_DISABLE_PTY;
    },
  };
}

test("GET /assets serves the static bundle with the correct headers and MIME types", async (t) => {
  const assetsRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-assets-fixture-"));
  await writeFile(path.join(assetsRoot, "index.js"), "export const hi = 1;\n");
  await writeFile(path.join(assetsRoot, "index-deadbeef01.js"), "export const hi = 2;\n");
  await writeFile(path.join(assetsRoot, "styles.css"), "body{color:red}\n");
  await writeFile(path.join(assetsRoot, "manifest-deadbeef02.json"), "{}\n");
  await writeFile(path.join(assetsRoot, "font-deadbeef03.woff2"), "font-bytes");
  await writeFile(path.join(assetsRoot, "font-deadbeef04.ttf"), "font-bytes");
  await writeFile(path.join(assetsRoot, "index-deadbeef01.js.map"), "{}\n");
  await mkdir(path.join(assetsRoot, "outside-secret"), { recursive: true });
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-assets-outside-"));
  await writeFile(path.join(outsideRoot, "secret.txt"), "do not serve me");
  try {
    await symlink(outsideRoot, path.join(assetsRoot, "escape"), "junction");
  } catch {
    // Symlink creation can require elevated privileges on some CI runners;
    // the traversal assertions below still cover the lexical checks.
  }

  const ctx = await startGateway(assetsRoot);
  t.after(async () => {
    await ctx.close();
    await rm(assetsRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  // Reachable while OpenVSCode is still starting (key route-ordering guard):
  // no `--openvscode-root`/`--ide-url` was configured, so `runtime.target`
  // stays unset and the basePath is gated with 503.
  const gated = await fetch(`${ctx.started.origin}${ctx.runtime.basePath}/`);
  assert.equal(gated.status, 503);
  const asset = await fetch(`${ctx.started.origin}/assets/index.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(asset.headers.get("access-control-allow-origin"), "*");
  assert.equal(asset.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
  assert.equal(asset.headers.get("cache-control"), "no-store");
  assert.equal(await asset.text(), "export const hi = 1;\n");

  const hashed = await fetch(`${ctx.started.origin}/assets/index-deadbeef01.js`);
  assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const css = await fetch(`${ctx.started.origin}/assets/styles.css`);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");

  const woff2 = await fetch(`${ctx.started.origin}/assets/font-deadbeef03.woff2`);
  assert.equal(woff2.headers.get("content-type"), "font/woff2");

  const ttf = await fetch(`${ctx.started.origin}/assets/font-deadbeef04.ttf`);
  assert.equal(ttf.headers.get("content-type"), "font/ttf");

  const map = await fetch(`${ctx.started.origin}/assets/index-deadbeef01.js.map`);
  assert.equal(map.headers.get("content-type"), "application/json; charset=utf-8");

  const head = await fetch(`${ctx.started.origin}/assets/index.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);

  const postRejected = await fetch(`${ctx.started.origin}/assets/index.js`, { method: "POST" });
  assert.equal(postRejected.status, 405);

  const missing = await fetch(`${ctx.started.origin}/assets/does-not-exist.js`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "ASSET_NOT_FOUND" });

  for (const traversal of [
    "/assets/../../package.json",
    "/assets/%2e%2e/%2e%2e/package.json",
    "/assets/..%2f..%2fpackage.json",
    "/assets/escape/secret.txt",
  ]) {
    const response = await fetch(`${ctx.started.origin}${traversal}`, { redirect: "manual" });
    assert.ok(
      response.status === 404 || (response.status >= 300 && response.status < 400),
      `expected ${traversal} to be blocked, got ${response.status}`,
    );
    if (response.status >= 300 && response.status < 400) {
      // Some HTTP clients/servers normalise ".." in the URL before it ever
      // reaches Express; if a redirect happens, follow it once and confirm
      // the final response is still not a 200 leaking file contents.
      const followed = await fetch(`${ctx.started.origin}${traversal}`);
      assert.notEqual(followed.status, 200);
    }
  }
});
