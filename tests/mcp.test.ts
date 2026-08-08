import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VscodeCore } from "../src/core/core.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

test("MCP server exposes the app resource and complete baseline tool surface", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-mcp-"));
  const core = new VscodeCore(root);
  await core.initialize();
  t.after(async () => {
    await core.close();
    await rm(root, { recursive: true, force: true });
  });
  const runtime = {
    status: () => ({
      state: "ready",
      browserUrl: "https://editor.example.test/ide/",
      logs: [],
    }),
  } as unknown as OpenVscodeRuntime;
  const server = createMcpServer({
    core,
    runtime,
    gatewayOrigin: "https://editor.example.test",
    appHtmlPath: path.resolve("src/app/index.html"),
  });
  const client = new Client(
    { name: "mcp-vscode-tests", version: "1.0.0" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
        },
      } as never,
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  assert.ok(names.size >= 25, `expected at least 25 tools, got ${names.size}`);
  for (const name of [
    "vscode_open",
    "fs_read",
    "fs_write",
    "editor_apply_edits",
    "terminal_create",
    "vscode_execute_command",
    "git_run",
  ]) assert.ok(names.has(name), `missing ${name}`);

  const write = await client.callTool({
    name: "fs_write",
    arguments: { path: "hello.txt", content: "hello MCP" },
  });
  assert.equal(write.isError, undefined);
  const read = await client.callTool({ name: "fs_read", arguments: { path: "hello.txt" } });
  assert.equal((read.structuredContent as { content: string }).content, "hello MCP");

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "ui://mcp-vscode/workbench.html"));
  const app = await client.readResource({ uri: "ui://mcp-vscode/workbench.html" });
  assert.equal(app.contents[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match("text" in app.contents[0]! ? app.contents[0].text : "", /MCP_VSCODE_APP/);

  const status = await client.callTool({ name: "workspace_status", arguments: {} });
  const payload = status.structuredContent as { uiToken?: string; assetsUrl?: string };
  assert.equal(payload.uiToken, core.bridgeToken);
  assert.equal(payload.assetsUrl, "https://editor.example.test/assets");
});

test("registerAppResource CSP metadata still lists the gateway origin after the /assets and /ui additions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-mcp-csp-"));
  const core = new VscodeCore(root);
  await core.initialize();
  t.after(async () => {
    await core.close();
    await rm(root, { recursive: true, force: true });
  });
  const runtime = {
    status: () => ({ state: "ready", browserUrl: "https://editor.example.test/ide/", logs: [] }),
  } as unknown as OpenVscodeRuntime;
  const server = createMcpServer({
    core,
    runtime,
    gatewayOrigin: "https://editor.example.test",
    appHtmlPath: path.resolve("src/app/index.html"),
  });
  const client = new Client(
    { name: "mcp-vscode-tests", version: "1.0.0" },
    {
      capabilities: {
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
      } as never,
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const app = await client.readResource({ uri: "ui://mcp-vscode/workbench.html" });
  interface CspMeta {
    frameDomains?: string[];
    connectDomains?: string[];
    resourceDomains?: string[];
    baseUriDomains?: string[];
  }
  const meta = (app.contents[0]?._meta as { ui?: { csp?: CspMeta } } | undefined)?.ui?.csp;
  assert.ok(meta, "expected _meta.ui.csp on the resource contents");
  assert.ok(meta!.connectDomains?.includes("https://editor.example.test"));
  assert.ok(meta!.connectDomains?.includes("wss://editor.example.test"));
  assert.ok(meta!.resourceDomains?.includes("https://editor.example.test"));
  assert.ok(meta!.baseUriDomains?.includes("https://editor.example.test"));
  // /assets and /ui are same-origin with the resource's own domain metadata,
  // so no additional CSP entries are required for them.
});
