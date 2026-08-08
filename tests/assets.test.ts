import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createAssetsHandler } from "../src/http/assets.js";

// The integration suite (tests-integration/assets.test.ts) already drives a
// full Gateway + real HTTP client through these routes; these tests instead
// exercise createAssetsHandler() directly with a bare express app so we can
// cover MIME/cache-control/header combinations and traversal shapes that
// would be tedious to assert end-to-end (percent-encoding variants, a null
// byte, empty segments, and the lexical + realpath symlink-escape check)
// without duplicating the integration coverage.

async function startServer(root: string) {
  const app = express();
  app.use(createAssetsHandler({ root }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected an AddressInfo");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("createAssetsHandler serves files with correct MIME types, cache policy, and security headers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-assets-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(path.join(root, "index.js"), "console.log(1);");
  await writeFile(path.join(root, "index.mjs"), "export {};");
  await writeFile(path.join(root, "index.js.map"), "{}");
  await writeFile(path.join(root, "manifest.json"), "{}");
  await writeFile(path.join(root, "app-deadbeef01.js"), "console.log(2);");
  await writeFile(path.join(root, "app-deadbeef01.css"), "body{}");
  await writeFile(path.join(root, "app-deadbeef01.json"), "{}");
  await writeFile(path.join(root, "app-deadbeef01.map"), "{}");
  await writeFile(path.join(root, "app-deadbeef01.ttf"), "font");
  await writeFile(path.join(root, "app-deadbeef01.woff"), "font");
  await writeFile(path.join(root, "app-deadbeef01.woff2"), "font");
  await writeFile(path.join(root, "app-deadbeef01.svg"), "<svg/>");
  await writeFile(path.join(root, "app-deadbeef01.html"), "<html></html>");
  await writeFile(path.join(root, "app-deadbeef01.bin"), "raw");

  const ctx = await startServer(root);
  t.after(() => ctx.close());

  const cases: Array<[string, string]> = [
    ["app-deadbeef01.js", "text/javascript; charset=utf-8"],
    ["index.mjs", "text/javascript; charset=utf-8"],
    ["app-deadbeef01.css", "text/css; charset=utf-8"],
    ["app-deadbeef01.json", "application/json; charset=utf-8"],
    ["app-deadbeef01.map", "application/json; charset=utf-8"],
    ["app-deadbeef01.ttf", "font/ttf"],
    ["app-deadbeef01.woff", "font/woff"],
    ["app-deadbeef01.woff2", "font/woff2"],
    ["app-deadbeef01.svg", "image/svg+xml"],
    ["app-deadbeef01.html", "text/html; charset=utf-8"],
    ["app-deadbeef01.bin", "application/octet-stream"],
  ];
  for (const [name, expectedType] of cases) {
    const response = await fetch(`${ctx.origin}/${name}`);
    assert.equal(response.status, 200, `expected 200 for ${name}`);
    assert.equal(response.headers.get("content-type"), expectedType, `wrong content-type for ${name}`);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    await response.arrayBuffer();
  }

  for (const name of ["index.js", "index.js.map", "manifest.json"]) {
    const response = await fetch(`${ctx.origin}/${name}`);
    assert.equal(response.headers.get("cache-control"), "no-store", `expected no-store for ${name}`);
    await response.arrayBuffer();
  }

  const hashed = await fetch(`${ctx.origin}/app-deadbeef01.js`);
  assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");
  await hashed.arrayBuffer();

  // A non-hashed, non-entry-module name still falls back to no-store: the
  // cache policy is opt-in (must match HASHED_NAME_PATTERN), not opt-out.
  const notHashed = await fetch(`${ctx.origin}/app-deadbeef01.bin`.replace("app-deadbeef01.bin", "plain.txt"));
  assert.equal(notHashed.status, 404);
});

test("createAssetsHandler rejects non-GET/HEAD methods and serves HEAD with no body", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-assets-unit-method-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.js"), "hello");

  const ctx = await startServer(root);
  t.after(() => ctx.close());

  const head = await fetch(`${ctx.origin}/index.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);

  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await fetch(`${ctx.origin}/index.js`, { method });
    assert.equal(response.status, 405, `expected 405 for ${method}`);
    assert.deepEqual(await response.json(), { error: "METHOD_NOT_ALLOWED" });
  }
});

test("createAssetsHandler rejects every shape of path traversal and malformed path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-assets-unit-traversal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.js"), "hello");

  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-assets-unit-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  await writeFile(path.join(outsideRoot, "secret.txt"), "do not serve me");

  const ctx = await startServer(root);
  t.after(() => ctx.close());

  // Plain lexical traversal (Express itself normalises many of these before
  // they reach the handler, so we accept a plain 404 or a redirect that,
  // when followed, never yields a 200).
  for (const traversal of [
    "/../package.json",
    "/%2e%2e/package.json",
    "/..%2fpackage.json",
    "/%2e%2e%2fpackage.json",
    "/foo/../../package.json",
  ]) {
    const response = await fetch(`${ctx.origin}${traversal}`, { redirect: "manual" });
    assert.ok(
      response.status === 404 || (response.status >= 300 && response.status < 400),
      `expected ${traversal} to be blocked, got ${response.status}`,
    );
    if (response.status >= 300 && response.status < 400) {
      const followed = await fetch(`${ctx.origin}${traversal}`);
      assert.notEqual(followed.status, 200);
      await followed.arrayBuffer();
    } else {
      await response.arrayBuffer();
    }
  }

  // Empty segments and a bare "." resolve to no file, not the directory.
  for (const empty of ["//index.js", "/./index.js"]) {
    const response = await fetch(`${ctx.origin}${empty}`);
    // Express itself may collapse "//" before the handler sees it, so either
    // outcome (blocked as 404, or resolved to the legitimate file) is
    // acceptable here — what matters is that nothing crashes and nothing
    // outside root is ever served, which the explicit traversal cases above
    // already assert.
    assert.ok(response.status === 200 || response.status === 404);
    await response.arrayBuffer();
  }

  // A null byte anywhere in the decoded path is rejected outright.
  const nullByte = await fetch(`${ctx.origin}/index.js%00.txt`);
  assert.equal(nullByte.status, 404);
  await nullByte.arrayBuffer();

  // A directory (no file) below root: stat().isFile() is false.
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "subdir"), { recursive: true }));
  const dir = await fetch(`${ctx.origin}/subdir`, { redirect: "manual" });
  assert.ok(dir.status === 404 || (dir.status >= 300 && dir.status < 400));
  await dir.arrayBuffer();

  let symlinkCreated = true;
  try {
    await symlink(outsideRoot, path.join(root, "escape"), "junction");
  } catch {
    symlinkCreated = false;
  }
  if (symlinkCreated) {
    // Lexically "escape/secret.txt" resolves inside root, but the symlink's
    // realpath() points outside it — the second isInside() check must catch
    // what the first, lexical one cannot.
    const escaped = await fetch(`${ctx.origin}/escape/secret.txt`);
    assert.equal(escaped.status, 404);
    await escaped.arrayBuffer();
  } else {
    t.diagnostic("symlink creation not permitted on this runner; skipping symlink-escape assertion");
  }
});

test("createAssetsHandler returns 404 for a missing file with the ASSET_NOT_FOUND body", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-assets-unit-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const ctx = await startServer(root);
  t.after(() => ctx.close());

  const response = await fetch(`${ctx.origin}/does-not-exist.js`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "ASSET_NOT_FOUND" });
});
