import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import WebSocket from "ws";
import { VscodeCore } from "../src/core/core.js";
import { Gateway } from "../src/http/gateway.js";
import { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

test("HTTP gateway serves MCP, proxies the workbench, and authenticates the bridge", async (t) => {
  process.env.MCP_VSCODE_DISABLE_PTY = "1";
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "mcp-vscode-gateway-"),
  );
  const mockIde = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<h1 data-path="${request.url}">Mock OpenVSCode</h1>`);
  });
  await new Promise<void>((resolve) => mockIde.listen(0, "127.0.0.1", resolve));
  const mockAddress = mockIde.address();
  assert.ok(mockAddress && typeof mockAddress !== "string");

  const core = new VscodeCore(workspace);
  await core.initialize();
  const runtime = new OpenVscodeRuntime({
    core,
    workspaceRoot: workspace,
    externalIdeUrl: `http://127.0.0.1:${mockAddress.port}`,
  });
  const gateway = new Gateway({
    core,
    runtime,
    host: "127.0.0.1",
    port: 0,
    authToken: "integration-token-00000000000000000000000000000000",
    appHtmlPath: path.resolve("dist/app.html"),
  });
  const started = await gateway.start();
  await runtime.start({
    gatewayOrigin: started.origin,
    bridgeUrl: gateway.localBridgeUrl,
  });

  t.after(async () => {
    await runtime.close();
    await core.close();
    await gateway.close();
    await new Promise<void>((resolve, reject) =>
      mockIde.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(workspace, { recursive: true, force: true });
    delete process.env.MCP_VSCODE_DISABLE_PTY;
  });

  const health = (await fetch(`${started.origin}/healthz`).then((response) =>
    response.json(),
  )) as { ok: boolean };
  assert.equal(health.ok, true);
  const appResponse = await fetch(`${started.origin}/app`, {
    headers: {
      Authorization:
        "Bearer integration-token-00000000000000000000000000000000",
    },
  });
  assert.equal(appResponse.status, 200);
  assert.match(await appResponse.text(), /__MCP_VSCODE_DEBUG__/);
  const sessionResponse = await fetch(`${started.origin}/session.json`, {
    headers: {
      Authorization:
        "Bearer integration-token-00000000000000000000000000000000",
    },
  });
  assert.equal(sessionResponse.status, 200);
  assert.equal(
    sessionResponse.headers.get("access-control-allow-origin"),
    null,
  );
  assert.match(sessionResponse.headers.get("cache-control") ?? "", /no-store/);
  const ideResponse = await fetch(`${started.origin}${runtime.basePath}/`, {
    headers: { accept: "text/html" },
  });
  assert.equal(ideResponse.status, 200);
  const ideBody = await ideResponse.text();
  assert.match(ideBody, /Mock OpenVSCode/);
  // Task 4: the proxied HTML document carries the liveness-handshake script,
  // and content-length is recomputed to match the (larger) injected body.
  assert.match(ideBody, /mcp-vscode:workbench-alive/);
  assert.equal(
    ideResponse.headers.get("content-length"),
    String(Buffer.byteLength(ideBody, "utf8")),
  );
  assert.equal(ideResponse.headers.get("transfer-encoding"), null);
  // x-frame-options / frame-ancestors stripping still applies after buffering.
  assert.equal(ideResponse.headers.get("x-frame-options"), null);

  const ideResponseNoAccept = await fetch(
    `${started.origin}${runtime.basePath}/plain`,
    {
      headers: { accept: "application/octet-stream" },
    },
  );
  assert.equal(ideResponseNoAccept.status, 200);
  assert.doesNotMatch(
    await ideResponseNoAccept.text(),
    /mcp-vscode:workbench-alive/,
  );

  const bearer = "Bearer integration-token-00000000000000000000000000000000";
  for (const endpoint of ["/mcp", "/session.json"]) {
    assert.equal((await fetch(started.origin + endpoint)).status, 401);
    assert.equal(
      (
        await fetch(
          started.origin +
            endpoint +
            "?token=integration-token-00000000000000000000000000000000",
        )
      ).status,
      401,
    );
  }
  const login = await fetch(started.origin + "/app");
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Access token/);
  for (const Origin of ["null", "https://attacker.invalid"]) {
    assert.equal(
      (
        await fetch(started.origin + "/mcp", {
          method: "POST",
          headers: {
            Origin,
            Authorization: bearer,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(started.origin + "/session.json", {
          headers: { Origin, Authorization: bearer },
        })
      ).status,
      403,
    );
  }
  const invalidHost = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      started.origin + "/mcp",
      {
        method: "POST",
        headers: { Host: "attacker.invalid", Authorization: bearer },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(invalidHost, 421);
  const opaqueIde = await fetch(started.origin + runtime.basePath + "/", {
    headers: { Origin: "null", Accept: "text/html" },
  });
  assert.equal(opaqueIde.status, 200);
  assert.equal(opaqueIde.headers.get("access-control-allow-origin"), "null");
  assert.equal(
    (
      await fetch(started.origin + runtime.basePath + "/", {
        headers: { Origin: "https://attacker.invalid" },
      })
    ).status,
    403,
  );
  const preflight = await fetch(started.origin + "/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: started.origin,
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /Mcp-Method/,
  );
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    id = 1,
  ) => {
    const response = await fetch(started.origin + "/mcp", {
      method: "POST",
      headers: {
        Authorization: bearer,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(typeof params.name === "string"
          ? { "Mcp-Name": params.name }
          : typeof params.uri === "string"
            ? { "Mcp-Name": params.uri }
            : {}),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const discovered = await rpc("server/discover");
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.result.resultType, "complete");
  const listed = await rpc("tools/list");
  assert.equal(listed.body.result.resultType, "complete");
  assert.equal(typeof listed.body.result.ttlMs, "number");
  assert.ok(listed.body.result.cacheScope);
  assert.ok(
    listed.body.result.tools.some(
      (tool: { name: string }) => tool.name === "vscode_open",
    ),
  );
  const saved = await rpc("tools/call", {
    name: "fs_write",
    arguments: { path: "modern.txt", content: "current protocol ✓" },
  });
  assert.notEqual(saved.body.result?.isError, true);
  assert.equal(saved.body.error, undefined);
  const [read, listing] = await Promise.all([
    rpc(
      "tools/call",
      { name: "fs_read", arguments: { path: "modern.txt" } },
      {},
      11,
    ),
    rpc("tools/list", {}, {}, 12),
  ]);
  assert.equal(read.body.id, 11);
  assert.equal(listing.body.id, 12);
  assert.equal(
    read.body.result.structuredContent.content,
    "current protocol ✓",
  );
  const resource = await rpc("resources/read", {
    uri: "ui://mcp-vscode/workbench.html",
  });
  assert.equal(
    resource.body.result.contents[0].mimeType,
    "text/html;profile=mcp-app",
  );
  assert.equal(
    (await rpc("tools/list", {}, { "Mcp-Method": "tools/call" })).status,
    400,
  );
  const malformed = await fetch(started.origin + "/mcp", {
    method: "POST",
    headers: { Authorization: bearer, "Content-Type": "application/json" },
    body: '{"private":"do-not-echo',
  });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /do-not-echo/);

  const client = new Client(
    { name: "gateway-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${started.origin}/mcp`),
    {
      requestInit: {
        headers: {
          authorization:
            "Bearer integration-token-00000000000000000000000000000000",
        },
      },
    },
  );
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "vscode_open"));
  await client.close();

  const socket = new WebSocket(gateway.localBridgeUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      token: core.bridgeToken,
      client: { name: "integration-bridge", version: "1.0.0" },
    }),
  );
  await waitUntil(() => core.bridge.status().connected);
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as {
      type: string;
      id?: string;
      method?: string;
    };
    if (message.type === "rpc" && message.id) {
      socket.send(
        JSON.stringify({
          type: "rpc-result",
          id: message.id,
          result: { method: message.method },
        }),
      );
    }
  });
  const bridgeRpc = await core.bridge.call<{ method: string }>(
    "commands.list",
    {},
  );
  assert.equal(bridgeRpc.method, "commands.list");
  const socketClosed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  socket.close();
  await socketClosed;
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met before timeout");
}
