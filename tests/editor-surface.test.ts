import assert from "node:assert/strict";
import test from "node:test";
import { EditorSurfaceRouter, type BridgeLike, type EditorSurface } from "../src/core/editor-surface.js";

function fakeBridge(connected: boolean): BridgeLike {
  return {
    status: () => ({ connected }),
    call: async () => {
      throw new Error("the fake bridge should not be called in this test");
    },
  };
}

function fakeNative(available: boolean): EditorSurface {
  return {
    kind: "native",
    available: () => available,
    call: async <T = unknown>() => ({ ok: true }) as T,
  };
}

test("resolves to the vscode surface when the bridge is connected", () => {
  const router = new EditorSurfaceRouter(fakeBridge(true));
  assert.equal(router.resolve().kind, "vscode");
});

test("resolves to the native surface when the bridge is down but a native client is attached", () => {
  const router = new EditorSurfaceRouter(fakeBridge(false));
  router.registerNative(fakeNative(true));
  assert.equal(router.resolve().kind, "native");
});

test("prefers the vscode surface over native when both are available", () => {
  const router = new EditorSurfaceRouter(fakeBridge(true));
  router.registerNative(fakeNative(true));
  assert.equal(router.resolve().kind, "vscode");
});

test("throws NO_EDITOR_SURFACE with an actionable message when neither surface is available", () => {
  const router = new EditorSurfaceRouter(fakeBridge(false));
  router.registerNative(fakeNative(false));
  assert.throws(
    () => router.resolve(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "NO_EDITOR_SURFACE");
      assert.match(error.message, /editor surface/i);
      assert.match(error.message, /vscode_open/);
      return true;
    },
  );
});

test("throws NO_EDITOR_SURFACE immediately when no native surface was ever registered", () => {
  const router = new EditorSurfaceRouter(fakeBridge(false));
  assert.throws(() => router.resolve(), { code: "NO_EDITOR_SURFACE" });
});

test("unregisterNative removes a stale registration so resolve() fails over correctly", () => {
  const router = new EditorSurfaceRouter(fakeBridge(false));
  const native = fakeNative(true);
  router.registerNative(native);
  assert.equal(router.resolve().kind, "native");
  router.unregisterNative(native);
  assert.throws(() => router.resolve(), { code: "NO_EDITOR_SURFACE" });
});

test("status() reports the resolved surface and both underlying flags", () => {
  const router = new EditorSurfaceRouter(fakeBridge(false));
  router.registerNative(fakeNative(true));
  assert.deepEqual(router.status(), { surface: "native", bridge: false, native: true });
});

test("status() reports 'none' when neither surface is available", () => {
  const router = new EditorSurfaceRouter(fakeBridge(false));
  assert.deepEqual(router.status(), { surface: "none", bridge: false, native: false });
});
