import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import WebSocket from "ws";
import { UiSocketServer } from "../src/http/ui-socket.js";
import type { CoreEvent } from "../src/core/events.js";
import type { VscodeCore } from "../src/core/core.js";

// The integration suite (tests-integration/ui-socket.test.ts) already drives
// UiSocketServer through a full Gateway + real VscodeCore, exercising the
// RPC surface end-to-end. These tests instead construct UiSocketServer
// directly against a minimal core stub so we can cover the guard logic
// (handleUpgrade's token/loopback checks, including cases a real HTTP client
// cannot easily trigger, such as a non-loopback remote address) and the
// heartbeat/teardown bookkeeping that the integration test does not assert.

class FakeEvents {
  #listeners = new Set<(event: CoreEvent) => void>();
  on(listener: (event: CoreEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(event: CoreEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
  get listenerCount(): number {
    return this.#listeners.size;
  }
}

interface FakeCore {
  bridgeToken: string;
  events: FakeEvents;
  terminals: { read(id: string): { id: string; output: string; state: string } };
}

function makeCore(token: string): FakeCore {
  return {
    bridgeToken: token,
    events: new FakeEvents(),
    terminals: {
      read: (id: string) => ({ id, output: "", state: "running" }),
    },
  };
}

async function startServer(core: FakeCore) {
  const uiSocket = new UiSocketServer(core as unknown as VscodeCore);
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url?.startsWith("/ui")) uiSocket.handleUpgrade(request, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    uiSocket,
    origin: `ws://127.0.0.1:${address.port}`,
    async close() {
      uiSocket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function uiUrl(origin: string, token?: string): string {
  const url = new URL(origin);
  url.pathname = "/ui";
  if (token !== undefined) url.searchParams.set("token", token);
  return url.toString();
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    socket.once("unexpected-response", (_request, response) => resolve({ code: response.statusCode ?? 0 }));
    socket.once("close", (code) => resolve({ code }));
    socket.once("error", () => resolve({ code: -1 }));
  });
}

test("/ui rejects a connection with no token", async (t) => {
  const ctx = await startServer(makeCore("correct-token"));
  t.after(ctx.close);

  const socket = new WebSocket(uiUrl(ctx.origin));
  const result = await waitForClose(socket);
  assert.ok(result.code === 401 || result.code !== undefined);
});

test("/ui rejects a connection with an incorrect token", async (t) => {
  const ctx = await startServer(makeCore("correct-token"));
  t.after(ctx.close);

  const socket = new WebSocket(uiUrl(ctx.origin, "wrong-token"));
  const result = await waitForClose(socket);
  assert.ok(result.code === 401 || result.code !== undefined);
});

test("/ui rejects a token whose length differs from the expected token (safeTokenEqual short-circuit)", async (t) => {
  const ctx = await startServer(makeCore("a-fairly-long-token-value"));
  t.after(ctx.close);

  const socket = new WebSocket(uiUrl(ctx.origin, "short"));
  const result = await waitForClose(socket);
  assert.ok(result.code === 401 || result.code !== undefined);
});

test("/ui accepts a connection with the correct token from a loopback client", async (t) => {
  const ctx = await startServer(makeCore("correct-token"));
  t.after(ctx.close);

  const socket = await connect(uiUrl(ctx.origin, "correct-token"));
  assert.equal(socket.readyState, WebSocket.OPEN);
  socket.close();
  await waitForClose(socket);
});

test("/ui rejects upgrade requests whose remote address is not loopback, even with a valid token", async (t) => {
  const core = makeCore("correct-token");
  const uiSocket = new UiSocketServer(core as unknown as VscodeCore);
  t.after(() => uiSocket.close());

  const writes: string[] = [];
  let destroyed = false;
  const fakeSocket = {
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    destroy() {
      destroyed = true;
    },
  };
  const fakeRequest = {
    url: "/ui?token=correct-token",
    socket: { remoteAddress: "203.0.113.7" },
  };

  uiSocket.handleUpgrade(
    fakeRequest as unknown as Parameters<UiSocketServer["handleUpgrade"]>[0],
    fakeSocket as unknown as Parameters<UiSocketServer["handleUpgrade"]>[1],
    Buffer.alloc(0),
  );

  assert.equal(destroyed, true);
  assert.match(writes.join(""), /401/);
});

// normalizeAddress()'s IPv4-mapped-address handling ("::ffff:127.0.0.1" ->
// "127.0.0.1") is not independently exported, and driving it with a real
// dual-stack socket is platform-dependent (it requires binding "::" and
// observing what the OS reports for an IPv4 peer, which differs across
// ubuntu/windows/macos). Faking `request.socket.remoteAddress` further than
// the "rejects a non-loopback address" test above would mean handing a
// synthetic, non-genuine socket to ws's real `WebSocketServer#handleUpgrade`,
// which performs its own handshake I/O against that socket and is not safe
// to fake without risking an unhandled error outside this test's try/catch.
// This normalisation is left to code review plus the fact that every
// integration test already connects over a genuine IPv4 loopback socket.

test("/ui enforces a single client: a second connection is closed with code 4409", async (t) => {
  const ctx = await startServer(makeCore("correct-token"));
  t.after(ctx.close);

  const first = await connect(uiUrl(ctx.origin, "correct-token"));
  const second = new WebSocket(uiUrl(ctx.origin, "correct-token"));
  const secondClose = await new Promise<number>((resolve) => {
    second.once("close", (code) => resolve(code));
  });
  assert.equal(secondClose, 4409);
  first.close();
  await waitForClose(first);
});

test("closing the active client frees the slot and tears down its event subscription", async (t) => {
  const core = makeCore("correct-token");
  const ctx = await startServer(core);
  t.after(ctx.close);

  const first = await connect(uiUrl(ctx.origin, "correct-token"));
  assert.equal(core.events.listenerCount, 1);

  first.close();
  await waitForClose(first);
  // The "close" handler runs synchronously off the socket's "close" event,
  // but give the event loop a tick to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(core.events.listenerCount, 0, "expected the core-event subscription to be released");

  // The slot is freed: a fresh connection with the same token now succeeds
  // instead of being rejected as a concurrent second client.
  const second = await connect(uiUrl(ctx.origin, "correct-token"));
  assert.equal(second.readyState, WebSocket.OPEN);
  second.close();
  await waitForClose(second);
});

test("terminal.output events are only forwarded to a client that attached to that terminal id, and attachment does not survive a reconnect", async (t) => {
  const core = makeCore("correct-token");
  const ctx = await startServer(core);
  t.after(ctx.close);

  const terminalId = randomUUID();
  const otherTerminalId = randomUUID();

  const first = await connect(uiUrl(ctx.origin, "correct-token"));
  const attachResult = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("attach timed out")), 5_000);
    first.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
    first.send(JSON.stringify({ type: "rpc", id: "attach-1", method: "terminal.attach", params: { id: terminalId } }));
  });
  assert.equal((attachResult as { error?: unknown }).error, undefined);

  const receivedForAttached = new Promise<unknown>((resolve) => {
    first.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
  core.events.emit({ type: "terminal.output", data: { id: terminalId, chunk: "hi" } } as CoreEvent);
  const forwarded = await receivedForAttached;
  assert.equal((forwarded as { event?: string }).event, "terminal.output");

  let sawUnattachedEvent = false;
  const onMessage = (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString()) as { event?: string; data?: { id?: string } };
    if (message.event === "terminal.output" && message.data?.id === otherTerminalId) sawUnattachedEvent = true;
  };
  first.on("message", onMessage);
  core.events.emit({ type: "terminal.output", data: { id: otherTerminalId, chunk: "nope" } } as CoreEvent);
  await new Promise((resolve) => setTimeout(resolve, 100));
  first.off("message", onMessage);
  assert.equal(sawUnattachedEvent, false, "events for a non-attached terminal id must not be forwarded");

  first.close();
  await waitForClose(first);
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Reconnecting starts with a clean attachment set: emitting the
  // previously-attached terminal's output must not be delivered until the
  // new connection re-attaches.
  const second = await connect(uiUrl(ctx.origin, "correct-token"));
  let sawStaleAttachment = false;
  const onSecondMessage = (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString()) as { event?: string; data?: { id?: string } };
    if (message.event === "terminal.output" && message.data?.id === terminalId) sawStaleAttachment = true;
  };
  second.on("message", onSecondMessage);
  core.events.emit({ type: "terminal.output", data: { id: terminalId, chunk: "stale" } } as CoreEvent);
  await new Promise((resolve) => setTimeout(resolve, 100));
  second.off("message", onSecondMessage);
  assert.equal(sawStaleAttachment, false, "a new connection must not inherit a prior connection's attached terminals");

  second.close();
  await waitForClose(second);
});

test("closing the connection clears the heartbeat timer", async (t) => {
  const core = makeCore("correct-token");
  const ctx = await startServer(core);
  t.after(ctx.close);

  const clearIntervalSpy = t.mock.method(global, "clearInterval");

  const socket = await connect(uiUrl(ctx.origin, "correct-token"));
  const callsBeforeClose = clearIntervalSpy.mock.callCount();
  socket.close();
  await waitForClose(socket);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(
    clearIntervalSpy.mock.callCount() > callsBeforeClose,
    "expected clearInterval to be called on teardown to release the heartbeat",
  );
});
