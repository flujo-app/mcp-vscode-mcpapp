import assert from "node:assert/strict";
import { access, readFile, readlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { discoverChromiumExecutable } from "../src/runtime/chromium-discovery.js";
import { selectChromiumIdentity } from "../src/runtime/chromium-identity.js";
import { launchSystemChromium } from "../src/runtime/workbench-stream.js";
import type { StreamBrowserSession } from "../src/runtime/workbench-stream.js";

// Hosted Linux/macOS images carry mutable, unpinned browser installs. Keep one
// genuine hosted-runner smoke test on Windows while deterministic launch and
// isolation tests continue to cover every platform.
const hostedBrowserSkip = process.env.GITHUB_ACTIONS === "true" && process.platform !== "win32"
  ? "GitHub Actions system Chromium is smoke-tested on Windows only"
  : false;

test("an installed system Chromium emits a genuine CDP screencast frame", {
  skip: hostedBrowserSkip,
  timeout: 45_000,
}, async (t) => {
  const executable = await discoverChromiumExecutable();
  if (!executable) {
    t.skip("no system Edge, Chrome, or Chromium installation");
    return;
  }

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body style='background:#123456;color:white'>stream smoke</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  let browser: StreamBrowserSession | undefined;
  t.after(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const launchedBrowser = await launchSystemChromium({
    targetUrl: `http://127.0.0.1:${address.port}/`,
    browserExecutable: executable,
    noSandbox: false,
    width: 640,
    height: 480,
  });
  browser = launchedBrowser;
  if (process.platform === "linux") {
    await assertLinuxBrowserIsolation(launchedBrowser);
  }
  const frame = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("real Chromium screencast frame timed out")), 10_000);
    const unsubscribe = launchedBrowser.onEvent((method, params) => {
      if (method !== "Page.screencastFrame" || typeof params.data !== "string") return;
      clearTimeout(timer);
      unsubscribe();
      const sessionId = params.sessionId;
      if (typeof sessionId === "number") {
        void launchedBrowser.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      }
      resolve(params.data);
    });
  });
  await launchedBrowser.send("Page.startScreencast", {
    format: "jpeg",
    quality: 50,
    maxWidth: 640,
    maxHeight: 480,
    everyNthFrame: 1,
  });

  const base64 = await frame;
  assert.ok(base64.length > 1_000, `expected a non-trivial JPEG frame, got ${base64.length} base64 characters`);
  const jpeg = Buffer.from(base64, "base64");
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);

  const profileDirectory = launchedBrowser.profileDirectory;
  assert.ok(profileDirectory, "real Chromium session should expose its ephemeral profile for cleanup verification");
  await launchedBrowser.close();
  browser = undefined;
  await assert.rejects(access(profileDirectory), "closing Chromium should remove its ephemeral profile");
});

async function assertLinuxBrowserIsolation(browser: StreamBrowserSession): Promise<void> {
  const processId = browser.processId;
  const profileDirectory = browser.profileDirectory;
  assert.ok(processId, "real Chromium session should expose its process id for isolation verification");
  assert.ok(profileDirectory, "real Chromium session should expose its ephemeral profile for isolation verification");

  const [status, rawEnvironment, cwd, commandLine] = await Promise.all([
    readFile(`/proc/${processId}/status`, "utf8"),
    readFile(`/proc/${processId}/environ`, "utf8"),
    readlink(`/proc/${processId}/cwd`),
    readFile(`/proc/${processId}/cmdline`, "utf8"),
  ]);
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
  const gid = Number(/^Gid:\s+(\d+)/m.exec(status)?.[1]);
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  const effectiveGid = typeof process.getegid === "function" ? process.getegid() : undefined;

  if (effectiveUid === 0) {
    const decision = selectChromiumIdentity({
      platform: "linux",
      effectiveUid,
      noSandbox: false,
      passwd: await readFile("/etc/passwd", "utf8"),
    });
    assert.equal(decision.kind, "drop");
    if (decision.kind === "drop") {
      assert.equal(uid, decision.uid, "Chromium must not inherit root uid");
      assert.equal(gid, decision.gid, "Chromium must not inherit root gid");
    }
    const groups = /^Groups:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number) ?? [];
    assert.ok(!groups.includes(0), "Chromium must not retain root as a supplementary group");
  } else {
    assert.equal(uid, effectiveUid);
    assert.equal(gid, effectiveGid);
  }

  const environment = new Map(rawEnvironment.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
  }));
  for (const name of [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
  ]) {
    const value = environment.get(name);
    assert.ok(value && path.resolve(value).startsWith(`${path.resolve(profileDirectory)}${path.sep}`), `${name} must be profile-local`);
  }
  assert.equal(path.resolve(cwd), path.join(path.resolve(profileDirectory), "home"));
  assert.ok(!commandLine.split("\0").includes("--no-sandbox"), "sandboxed launch must not silently add --no-sandbox");
}
