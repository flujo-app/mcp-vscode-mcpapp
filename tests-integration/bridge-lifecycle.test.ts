import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { VscodeBridge } from "../src/core/bridge.js";
import { CoreEvents } from "../src/core/events.js";
test("editor RPCs settle on deadline, disconnect and replacement; late results cannot cross clients", async (t) => {
  const bridge = new VscodeBridge("local-bridge-test-token", new CoreEvents());
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) =>
    bridge.handleUpgrade(req, socket, head),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function connect() {
    const ws = new WebSocket(
      "ws://127.0.0.1:" + (address as { port: number }).port,
    );
    await once(ws, "open");
    const hello = once(ws, "message");
    ws.send(
      JSON.stringify({ type: "hello", token: "local-bridge-test-token" }),
    );
    await hello;
    return ws;
  }
  let socket = await connect();
  const deadline = bridge.call("files.save", { text: "bounded" }, 30);
  await assert.rejects(deadline, (e: any) => e.code === "VSCODE_RPC_TIMEOUT");
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "rpc")
      socket.send(
        JSON.stringify({
          type: "rpc-result",
          id: msg.id,
          result: "acknowledged",
        }),
      );
  });
  assert.equal(await bridge.call("files.save", {}, 1000), "acknowledged");
  socket.removeAllListeners("message");
  const disconnected = bridge.call("files.save", {}, 5000);
  const rejected = assert.rejects(
    disconnected,
    (e: any) => e.code === "VSCODE_BRIDGE_DISCONNECTED",
  );
  socket.terminate();
  await rejected;
  socket = await connect();
  const replaced = bridge.call("files.save", {}, 5000);
  const rejectedReplacement = assert.rejects(
    replaced,
    (e: any) => e.code === "VSCODE_BRIDGE_DISCONNECTED",
  );
  const newer = await connect();
  await rejectedReplacement;
  newer.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "rpc")
      newer.send(
        JSON.stringify({
          type: "rpc-result",
          id: msg.id,
          result: "new editor",
        }),
      );
  });
  assert.equal(await bridge.call("files.save", {}, 1000), "new editor");
  newer.terminate();
});
