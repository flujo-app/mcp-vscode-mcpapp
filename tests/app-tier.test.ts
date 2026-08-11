import assert from "node:assert/strict";
import test from "node:test";
import { framePolicyForUrl, selectTier, sessionWithAppMeta } from "../src/app/tier.js";
import { WORKBENCH_IDE_META_KEY, WORKBENCH_STREAM_META_KEY } from "../src/stream/protocol.js";

// Pure-function slice of the renderer policy. The iframe liveness handshake
// is exercised by the browser-facing integration checks.

test("framePolicyForUrl reports unknown when the host omitted sandbox CSP capabilities", () => {
  assert.equal(framePolicyForUrl("https://editor.example.test/ide/abc/", undefined, false), "unknown");
});

test("framePolicyForUrl accepts the exact workbench origin", () => {
  assert.equal(
    framePolicyForUrl(
      "https://editor.example.test/ide/abc/",
      ["https://editor.example.test"],
      true,
    ),
    "allowed",
  );
});

test("framePolicyForUrl accepts a CSP loopback port-wildcard grant (FLUJO canonical form)", () => {
  // FLUJO collapses loopback grants to `scheme://host:*` so a gateway's
  // ephemeral-port restart keeps the committed policy valid.
  assert.equal(
    framePolicyForUrl("http://127.0.0.1:45283/ide/abc/", ["http://127.0.0.1:*"], true),
    "allowed",
  );
  assert.equal(
    framePolicyForUrl("http://localhost:45283/", ["http://LOCALHOST:*"], true),
    "allowed",
  );
  assert.equal(
    framePolicyForUrl("http://[::1]:45283/", ["http://[::1]:*"], true),
    "allowed",
  );
  // Wrong scheme or host must still be denied.
  assert.equal(
    framePolicyForUrl("https://127.0.0.1:45283/", ["http://127.0.0.1:*"], true),
    "denied",
  );
  assert.equal(
    framePolicyForUrl("http://192.168.1.20:45283/", ["http://127.0.0.1:*"], true),
    "denied",
  );
});

test("framePolicyForUrl rejects an absent or different approved origin", () => {
  assert.equal(framePolicyForUrl("https://editor.example.test/", [], true), "denied");
  assert.equal(
    framePolicyForUrl("https://editor.example.test/", ["https://other.example.test"], true),
    "denied",
  );
});

test("App-only metadata restores IDE and stream capability URLs for the renderer", () => {
  const payload = {
    openVscode: { state: "ready" },
    stream: { enabled: true, experimental: true as const, state: "idle" as const },
  };
  const merged = sessionWithAppMeta(payload, {
    [WORKBENCH_IDE_META_KEY]: { ideUrl: "https://app.example.test/ide/secret/" },
    [WORKBENCH_STREAM_META_KEY]: { websocketUrl: "wss://app.example.test/stream?token=secret" },
  });
  assert.equal(merged?.ideUrl, "https://app.example.test/ide/secret/");
  assert.equal(merged?.stream?.websocketUrl, "wss://app.example.test/stream?token=secret");
  assert.equal("ideUrl" in payload, false, "the model-visible payload is not mutated");
});

test("selectTier reports browser instead of substituting a fake editor when no workbench URL exists", async () => {
  const frame = {} as HTMLIFrameElement;
  const result = await selectTier({}, frame);
  assert.equal(result.tier, "browser");
  assert.match(result.reason, /no workbench URL/i);
});

test("selectTier chooses genuine pixel streaming only after explicit server opt-in", async () => {
  let navigated = false;
  const frame = {
    set src(_value: string) {
      navigated = true;
    },
  } as HTMLIFrameElement;
  const result = await selectTier({
    ideUrl: "https://editor.example.test/ide/abc/",
    stream: {
      enabled: true,
      experimental: true,
      state: "idle",
      websocketUrl: "wss://editor.example.test/stream?token=app-only",
    },
  }, frame, { framePolicy: "denied" });
  assert.equal(result.tier, "stream");
  assert.equal(navigated, false);
  assert.match(result.reason, /explicitly enabled/i);
});

test("explicit streaming fails honestly when its app-only endpoint is absent", async () => {
  const result = await selectTier({
    ideUrl: "https://editor.example.test/ide/abc/",
    stream: { enabled: true, experimental: true, state: "idle" },
  }, {} as HTMLIFrameElement);
  assert.equal(result.tier, "browser");
  assert.match(result.reason, /no app-only stream endpoint/i);
});

test("selectTier does not navigate when the host explicitly denied frameDomains", async () => {
  let navigated = false;
  const frame = {
    set src(_value: string) {
      navigated = true;
    },
  } as HTMLIFrameElement;
  const result = await selectTier(
    { ideUrl: "https://editor.example.test/ide/abc/" },
    frame,
    { framePolicy: "denied" },
  );
  assert.equal(result.tier, "browser");
  assert.equal(navigated, false);
  assert.match(result.reason, /did not approve/i);
});
