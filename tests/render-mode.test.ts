import assert from "node:assert/strict";
import test from "node:test";
import { parseBooleanEnv, parseRenderMode } from "../src/runtime/render-mode.js";

test("render mode defaults to the genuine iframe/browser behavior", () => {
  assert.equal(parseRenderMode(undefined), "default");
  assert.equal(parseRenderMode(""), "default");
  assert.equal(parseRenderMode("default"), "default");
});

test("pixel streaming is explicitly opt-in", () => {
  assert.equal(parseRenderMode("stream"), "stream");
  assert.throws(() => parseRenderMode("portable"), /expected "default" or "stream"/);
});

test("security-sensitive boolean environment flags are strict", () => {
  assert.equal(parseBooleanEnv("TEST_FLAG", undefined), false);
  assert.equal(parseBooleanEnv("TEST_FLAG", "0"), false);
  assert.equal(parseBooleanEnv("TEST_FLAG", "true"), true);
  assert.throws(() => parseBooleanEnv("TEST_FLAG", "yes"), /expected 0, 1, false, or true/);
});
