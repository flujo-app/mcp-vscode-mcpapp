import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNpmViewPayload } from "../scripts/lib/npm-spawn.mjs";

test("npm view payload normalization preserves scalar field values", () => {
  assert.equal(normalizeNpmViewPayload("0.2.1"), "0.2.1");
});

test("npm view payload normalization unwraps a singleton array", () => {
  assert.equal(normalizeNpmViewPayload(["0.2.1"]), "0.2.1");
});

test("npm view payload normalization leaves ambiguous arrays intact", () => {
  const payload = ["0.2.0", "0.2.1"];
  assert.equal(normalizeNpmViewPayload(payload), payload);
});
