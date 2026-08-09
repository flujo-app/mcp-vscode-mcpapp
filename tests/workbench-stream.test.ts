import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import WebSocket from "ws";
import {
  StreamUnavailableError,
  WorkbenchStreamController,
  type StreamBrowserSession,
} from "../src/runtime/workbench-stream.js";
import type {
  WorkbenchStreamClientMessage,
  WorkbenchStreamServerMessage,
} from "../src/stream/protocol.js";
import type { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

class FakeBrowser implements StreamBrowserSession {
  readonly browser = "fake-system-browser";
  readonly sessionId = "fake-session";
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false;
  #events = new Set<(method: string, params: Record<string, unknown>) => void>();
  #closeListeners = new Set<(error?: Error) => void>();

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ method, params });
    return {} as T;
  }

  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  emit(method: string, params: Record<string, unknown>): void {
    for (const listener of [...this.#events]) listener(method, params);
  }

  crash(error: Error): void {
    for (const listener of [...this.#closeListeners]) listener(error);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeRuntime(state = "ready"): OpenVscodeRuntime {
  return {
    target: "http://127.0.0.1:43123",
    basePath: "/ide/unguessable",
    status: () => ({ state, logs: [] }),
  } as unknown as OpenVscodeRuntime;
}

async function serve(t: TestContext, controller: WorkbenchStreamController) {
  const server = http.createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket, head) => controller.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await controller.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { origin, url: controller.status(origin).websocketUrl! };
}

const inboxes = new WeakMap<WebSocket, WorkbenchStreamServerMessage[]>();

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox: WorkbenchStreamServerMessage[] = [];
    inboxes.set(socket, inbox);
    socket.on("message", (raw) => inbox.push(JSON.parse(raw.toString()) as WorkbenchStreamServerMessage));
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function nextMessage(socket: WebSocket, predicate: (message: WorkbenchStreamServerMessage) => boolean) {
  const inbox = inboxes.get(socket)!;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const index = inbox.findIndex(predicate);
    if (index >= 0) return inbox.splice(index, 1)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("stream message timed out");
}

function send(socket: WebSocket, message: WorkbenchStreamClientMessage | Record<string, unknown>): void {
  socket.send(JSON.stringify(message));
}

test("disabled streaming exposes no authenticated endpoint", () => {
  const controller = new WorkbenchStreamController({ enabled: false, runtime: fakeRuntime() });
  assert.deepEqual(controller.status("https://example.test"), {
    enabled: false,
    experimental: true,
    state: "disabled",
  });
});

test("/stream rejects missing and invalid independent stream tokens", async (t) => {
  const controller = new WorkbenchStreamController({ enabled: true, runtime: fakeRuntime() });
  const { origin, url } = await serve(t, controller);
  assert.match(url, /^ws:\/\/127\.0\.0\.1:/);
  assert.ok(new URL(url).searchParams.get("token")?.length! >= 40);

  for (const candidate of [`${origin.replace("http", "ws")}/stream`, `${origin.replace("http", "ws")}/stream?token=wrong`]) {
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(candidate);
      socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.once("error", () => resolve(0));
    });
    assert.equal(status, 401);
  }
});

test("stream reports an honest unavailable error when no system browser can launch", async (t) => {
  const controller = new WorkbenchStreamController({
    enabled: true,
    runtime: fakeRuntime(),
    launchBrowser: async () => {
      throw new StreamUnavailableError("No installed Chromium-family browser was found");
    },
  });
  const { url, origin } = await serve(t, controller);
  const socket = await connect(url);
  t.after(() => socket.close());
  const error = await nextMessage(socket, (message) => message.type === "error");
  assert.deepEqual(error, {
    type: "error",
    code: "STREAM_BROWSER_UNAVAILABLE",
    message: "No installed Chromium-family browser was found",
  });
  assert.equal(controller.status(origin).state, "unavailable");
  assert.equal(controller.status(origin).error, "No installed Chromium-family browser was found");
});

test("stream relays genuine browser frames and constrained user input", async (t) => {
  const browser = new FakeBrowser();
  const controller = new WorkbenchStreamController({
    enabled: true,
    runtime: fakeRuntime(),
    frameRate: 30,
    launchBrowser: async ({ targetUrl }) => {
      assert.equal(targetUrl, "http://127.0.0.1:43123/ide/unguessable/");
      return browser;
    },
  });
  const { url } = await serve(t, controller);
  const socket = await connect(url);
  t.after(() => socket.close());
  await nextMessage(socket, (message) => message.type === "status" && message.state === "ready");
  assert.ok(browser.commands.some(({ method }) => method === "Emulation.setDeviceMetricsOverride"));
  assert.ok(browser.commands.some(({ method }) => method === "Page.startScreencast"));

  const framePromise = nextMessage(socket, (message) => message.type === "frame");
  browser.emit("Page.screencastFrame", { data: "an-image", sessionId: 7 });
  const frame = await framePromise;
  assert.equal(frame.type, "frame");
  if (frame.type === "frame") {
    assert.equal(frame.data, "an-image");
    assert.equal(frame.format, "jpeg");
  }
  assert.ok(browser.commands.some(({ method, params }) => method === "Page.screencastFrameAck" && params.sessionId === 7));

  send(socket, {
    type: "pointer",
    event: "down",
    x: 50,
    y: 75,
    button: "left",
    buttons: 1,
    clickCount: 1,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  });
  await waitFor(() => browser.commands.some(({ method }) => method === "Input.dispatchMouseEvent"));
  const pointer = browser.commands.findLast(({ method }) => method === "Input.dispatchMouseEvent");
  assert.equal(pointer?.params.type, "mousePressed");
  assert.equal(pointer?.params.x, 50);

  const badMessage = nextMessage(socket, (message) => message.type === "error" && message.code === "BAD_STREAM_MESSAGE");
  send(socket, { type: "navigate", url: "https://attacker.example" });
  await badMessage;
  assert.ok(!browser.commands.some(({ method }) => method === "Page.navigate"), "viewer must not control browser navigation");
});

test("browser crashes become visible stream failures", async (t) => {
  const browser = new FakeBrowser();
  const controller = new WorkbenchStreamController({
    enabled: true,
    runtime: fakeRuntime(),
    launchBrowser: async () => browser,
  });
  const { url, origin } = await serve(t, controller);
  const socket = await connect(url);
  t.after(() => socket.close());
  await nextMessage(socket, (message) => message.type === "status" && message.state === "ready");
  const errorPromise = nextMessage(socket, (message) => message.type === "error");
  browser.crash(new Error("browser crashed"));
  const error = await errorPromise;
  assert.equal(error.type, "error");
  assert.equal(controller.status(origin).state, "failed");
  assert.equal(controller.status(origin).error, "browser crashed");
  await waitFor(() => browser.closed);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}
