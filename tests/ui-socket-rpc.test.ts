import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { VscodeCore } from "../src/core/core.js";
import { UiSocketServer } from "../src/http/ui-socket.js";

interface ServerHandle {
  core: VscodeCore;
  uiSocket: UiSocketServer;
  url: string;
}

async function withServer(t: TestContext, run: (handle: ServerHandle) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-ui-rpc-"));
  const core = new VscodeCore(root);
  await core.initialize();
  const uiSocket = new UiSocketServer(core);
  const server = http.createServer();
  server.on("upgrade", (request, socket, head) => uiSocket.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = `ws://127.0.0.1:${port}/ui?token=${core.bridgeToken}`;
  t.after(async () => {
    uiSocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await core.close();
    await rm(root, { recursive: true, force: true });
  });
  await run({ core, uiSocket, url });
}

function connect(t: TestContext, url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    t.after(() => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    });
  });
}

function parse(raw: { toString(): string }): Record<string, unknown> {
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

test("a server->client RPC round-trips through /ui via the new rpc-result reply", async (t) => {
  await withServer(t, async ({ uiSocket, url }) => {
    const client = await connect(t, url);
    client.on("message", (raw) => {
      const message = parse(raw);
      if (message.type === "rpc" && message.method === "ping.test") {
        client.send(JSON.stringify({ type: "rpc-result", id: message.id, result: { pong: message.params } }));
      }
    });
    const result = await uiSocket.call<{ pong: unknown }>("ping.test", { a: 1 });
    assert.deepEqual(result, { pong: { a: 1 } });
  });
});

test("an error rpc-result reply maps to UI_RPC_ERROR", async (t) => {
  await withServer(t, async ({ uiSocket, url }) => {
    const client = await connect(t, url);
    client.on("message", (raw) => {
      const message = parse(raw);
      if (message.type === "rpc") {
        client.send(JSON.stringify({ type: "rpc-result", id: message.id, error: { code: "BOOM", message: "nope" } }));
      }
    });
    await assert.rejects(
      () => uiSocket.call("will.fail"),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "UI_RPC_ERROR");
        return true;
      },
    );
  });
});

test("a non-answering client rejects with UI_RPC_TIMEOUT (short injected timeout)", async (t) => {
  await withServer(t, async ({ uiSocket, url }) => {
    await connect(t, url); // client attaches but never answers
    await assert.rejects(
      () => uiSocket.call("never.answers", {}, 50),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "UI_RPC_TIMEOUT");
        return true;
      },
    );
  });
});

test("closing the /ui socket rejects all pending calls with NO_EDITOR_SURFACE", async (t) => {
  await withServer(t, async ({ uiSocket, url }) => {
    const client = await connect(t, url);
    const pending = uiSocket.call("never.answers", {}, 5_000);
    client.close();
    await assert.rejects(
      () => pending,
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "NO_EDITOR_SURFACE");
        return true;
      },
    );
  });
});

test("calling with no client attached fails fast with NO_EDITOR_SURFACE", async (t) => {
  await withServer(t, async ({ uiSocket }) => {
    const start = Date.now();
    await assert.rejects(() => uiSocket.call("anything"), { code: "NO_EDITOR_SURFACE" });
    assert.ok(Date.now() - start < 1_000);
  });
});

test("legacy client->server workspace.* calls are unaffected by the new rpc-result handling", async (t) => {
  await withServer(t, async ({ url }) => {
    const client = await connect(t, url);
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      client.on("message", (raw) => resolve(parse(raw)));
      client.send(JSON.stringify({ type: "rpc", id: "1", method: "workspace.list", params: {} }));
    });
    assert.equal(reply.type, "rpc");
    assert.equal(reply.id, "1");
    assert.ok(Array.isArray((reply.result as { entries?: unknown[] })?.entries));
  });
});

test("status().attached tracks connect/disconnect promptly", async (t) => {
  await withServer(t, async ({ uiSocket, url }) => {
    assert.equal(uiSocket.status().attached, false);
    const client = await connect(t, url);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(uiSocket.status().attached, true);
    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      client.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(uiSocket.status().attached, false);
  });
});
