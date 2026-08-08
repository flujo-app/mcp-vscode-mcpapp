import assert from "node:assert/strict";
import test from "node:test";
import { uiSocketUrl } from "../src/app/tier.js";

// Pure-function slice of the Phase 2 tier machine (issue #7): the rest of
// `src/app/tier.ts` needs a DOM (WebSocket/iframe/postMessage) and is
// exercised by the browser-facing manual/integration checks instead.

test("uiSocketUrl derives ws:// from an http:// gateway origin and carries the token", () => {
  const url = uiSocketUrl("http://127.0.0.1:4123", "secret-token");
  assert.equal(url, "ws://127.0.0.1:4123/ui?token=secret-token");
});

test("uiSocketUrl derives wss:// from an https:// gateway origin", () => {
  const url = uiSocketUrl("https://example.test", "secret-token");
  assert.equal(url, "wss://example.test/ui?token=secret-token");
});
