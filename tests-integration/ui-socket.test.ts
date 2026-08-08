import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { VscodeCore } from "../src/core/core.js";
import { Gateway } from "../src/http/gateway.js";
import { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

interface RpcMessage {
  type: string;
  id?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: string; message: string };
  event?: string;
  data?: unknown;
}

async function startGateway() {
  process.env.MCP_VSCODE_DISABLE_PTY = "1";
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-ui-socket-"));
  const core = new VscodeCore(workspace);
  await core.initialize();
  const runtime = new OpenVscodeRuntime({ core, workspaceRoot: workspace });
  const gateway = new Gateway({
    core,
    runtime,
    host: "127.0.0.1",
    port: 0,
    appHtmlPath: path.resolve("dist/app.html"),
  });
  const started = await gateway.start();
  return {
    core,
    workspace,
    async close() {
      runtime.close();
      await core.close();
      await gateway.close();
      await rm(workspace, { recursive: true, force: true });
      delete process.env.MCP_VSCODE_DISABLE_PTY;
    },
    uiUrl(token?: string): string {
      const url = new URL(started.origin.replace(/^http/, "ws"));
      url.pathname = "/ui";
      if (token !== undefined) url.searchParams.set("token", token);
      return url.toString();
    },
  };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rpc(socket: WebSocket, method: string, params?: unknown): Promise<RpcMessage> {
  const id = `${method}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timed out: ${method}`)), 5_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as RpcMessage;
      if (message.type === "rpc" && message.id === id) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message);
      }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "rpc", id, method, params }));
  });
}

test("/ui rejects missing or incorrect tokens and accepts the bridge token", async (t) => {
  const ctx = await startGateway();
  t.after(() => ctx.close());

  const noToken = new WebSocket(ctx.uiUrl());
  const noTokenClosed = await new Promise<{ code: number }>((resolve) => {
    noToken.once("unexpected-response", (_request, response) => resolve({ code: response.statusCode ?? 0 }));
    noToken.once("close", (code) => resolve({ code }));
    noToken.once("error", () => resolve({ code: -1 }));
  });
  assert.ok(noTokenClosed.code === 401 || noTokenClosed.code !== undefined);

  const wrongToken = new WebSocket(ctx.uiUrl("not-the-token"));
  const wrongTokenResult = await new Promise<boolean>((resolve) => {
    wrongToken.once("unexpected-response", () => resolve(true));
    wrongToken.once("close", () => resolve(true));
    wrongToken.once("error", () => resolve(true));
  });
  assert.equal(wrongTokenResult, true);

  const socket = await connect(ctx.uiUrl(ctx.core.bridgeToken));
  assert.equal(socket.readyState, WebSocket.OPEN);
  socket.close();
});

test("/ui allows a single client and rejects a second concurrent connection", async (t) => {
  const ctx = await startGateway();
  t.after(() => ctx.close());

  const first = await connect(ctx.uiUrl(ctx.core.bridgeToken));
  const second = new WebSocket(ctx.uiUrl(ctx.core.bridgeToken));
  const secondClose = await new Promise<number>((resolve) => {
    second.once("close", (code) => resolve(code));
  });
  assert.equal(secondClose, 4409);
  first.close();
});

test("/ui RPC dispatch reuses the workspace sandbox and terminal lifecycle", async (t) => {
  const ctx = await startGateway();
  const socket = await connect(ctx.uiUrl(ctx.core.bridgeToken));
  t.after(async () => {
    socket.close();
    await ctx.close();
  });

  const write = await rpc(socket, "workspace.write", { path: "notes/a.txt", content: "hello ui" });
  assert.equal(write.error, undefined);

  const read = await rpc(socket, "workspace.read", { path: "notes/a.txt" });
  assert.equal((read.result as { content: string }).content, "hello ui");

  const list = await rpc(socket, "workspace.list", { path: ".", recursive: true });
  const entries = (list.result as { entries: Array<{ path: string }> }).entries;
  assert.ok(entries.some((entry) => entry.path === "notes/a.txt"));

  const escape = await rpc(socket, "workspace.read", { path: "../outside.txt" });
  assert.equal(escape.error?.code, "PATH_OUTSIDE_WORKSPACE");

  const unknown = await rpc(socket, "not.a.method", {});
  assert.equal(unknown.error?.code, "METHOD_NOT_FOUND");

  const editorState = await rpc(socket, "editor.state", {});
  assert.equal(editorState.error?.code, "VSCODE_BRIDGE_UNAVAILABLE");

  const created = await rpc(socket, "terminal.create", { columns: 80, rows: 24 });
  const terminalId = (created.result as { id: string }).id;
  assert.ok(terminalId);

  const eventPromise = new Promise<RpcMessage>((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as RpcMessage;
      if (message.type === "event" && message.event === "terminal.output") {
        socket.off("message", onMessage);
        resolve(message);
      }
    };
    socket.on("message", onMessage);
  });
  const attach = await rpc(socket, "terminal.attach", { id: terminalId });
  assert.equal((attach.result as { id: string }).id, terminalId);
  await rpc(socket, "terminal.write", { id: terminalId, data: "echo hi\n" });
  await eventPromise;

  const closed = await rpc(socket, "terminal.close", { id: terminalId });
  assert.equal((closed.result as { killed: boolean }).killed, true);
});
