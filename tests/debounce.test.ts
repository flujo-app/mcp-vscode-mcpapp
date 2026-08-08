import assert from "node:assert/strict";
import test from "node:test";
import { createDebouncer } from "../src/app/debounce.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Trailing-edge behaviour, cancellation, and dedupe of identical payloads
// (plan §4.1): `createDebouncer` has no equivalent in the repo before
// Phase 3.

test("trailing-edge: fn does not run before the quiet period elapses", async () => {
  let calls = 0;
  const debounced = createDebouncer<[number]>(20, () => {
    calls += 1;
  });
  debounced(1);
  assert.equal(calls, 0);
  await delay(5);
  assert.equal(calls, 0);
  await delay(25);
  assert.equal(calls, 1);
});

test("trailing-edge: rapid calls collapse into a single invocation with the latest args", async () => {
  const seen: number[] = [];
  const debounced = createDebouncer<[number]>(20, (n) => {
    seen.push(n);
  });
  debounced(1);
  debounced(2);
  debounced(3);
  await delay(35);
  assert.deepEqual(seen, [3]);
});

test("trailing-edge: a fresh call restarts the timer", async () => {
  const seen: number[] = [];
  const debounced = createDebouncer<[number]>(20, (n) => {
    seen.push(n);
  });
  debounced(1);
  await delay(12);
  debounced(2); // resets the 20ms window before the first would have fired
  await delay(12);
  assert.deepEqual(seen, []); // still pending -- only ~24ms of *continuous* quiet needed, but the window kept resetting
  await delay(15);
  assert.deepEqual(seen, [2]);
});

test("cancel() discards a pending call without running fn", async () => {
  let calls = 0;
  const debounced = createDebouncer<[]>(10, () => {
    calls += 1;
  });
  debounced();
  debounced.cancel();
  await delay(20);
  assert.equal(calls, 0);
});

test("cancel() is a safe no-op when nothing is pending", () => {
  const debounced = createDebouncer<[]>(10, () => undefined);
  assert.doesNotThrow(() => debounced.cancel());
});

test("flush() runs an armed call immediately with its latest args", () => {
  const seen: string[] = [];
  const debounced = createDebouncer<[string]>(1000, (s) => {
    seen.push(s);
  });
  debounced("a");
  debounced("b");
  debounced.flush();
  assert.deepEqual(seen, ["b"]);
  assert.equal(debounced.pending, false);
});

test("flush() is a no-op when nothing is pending", () => {
  let calls = 0;
  const debounced = createDebouncer<[]>(10, () => {
    calls += 1;
  });
  debounced.flush();
  assert.equal(calls, 0);
});

test("pending reflects whether a call is armed", async () => {
  const debounced = createDebouncer<[]>(15, () => undefined);
  assert.equal(debounced.pending, false);
  debounced();
  assert.equal(debounced.pending, true);
  await delay(25);
  assert.equal(debounced.pending, false);
});

test("dedupe: repeated identical payloads within the window still fire fn exactly once", async () => {
  const seen: Array<{ path: string; line: number }> = [];
  const debounced = createDebouncer<[{ path: string; line: number }]>(20, (payload) => {
    seen.push(payload);
  });
  const payload = { path: "a.ts", line: 1 };
  debounced(payload);
  debounced({ ...payload });
  debounced({ ...payload });
  await delay(35);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], payload);
});

test("dedupe: identical payloads sent in separate windows each fire fn", async () => {
  const seen: number[] = [];
  const debounced = createDebouncer<[number]>(15, (n) => {
    seen.push(n);
  });
  debounced(42);
  await delay(25);
  debounced(42);
  await delay(25);
  assert.deepEqual(seen, [42, 42]);
});
