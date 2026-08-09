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
import {
  WORKBENCH_IDE_META_KEY,
  WORKBENCH_STREAM_META_KEY,
} from "../src/stream/protocol.js";

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
      browserUrl: "https://editor.example.test/ide/top-secret-ide-token/",
      logs: [],
    }),
  } as unknown as OpenVscodeRuntime;
  const server = createMcpServer({
    core,
    runtime,
    gatewayOrigin: "https://editor.example.test",
    appHtmlPath: path.resolve("src/app/index.html"),
    stream: {
      status: () => ({
        enabled: true,
        experimental: true,
        state: "idle",
        websocketUrl: "wss://editor.example.test/stream?token=top-secret-stream-token",
      }),
    },
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
  const payload = status.structuredContent as {
    ideUrl?: string;
    openVscode?: { browserUrl?: string; basePath?: string; target?: string };
    stream?: { enabled?: boolean; websocketUrl?: string };
  };
  assert.equal(payload.ideUrl, undefined, "the IDE capability URL must not be model-visible");
  assert.equal(payload.openVscode?.browserUrl, undefined, "the nested runtime status must not leak the IDE URL");
  assert.equal(payload.openVscode?.basePath, undefined, "the unguessable IDE route must stay app-only");
  assert.equal(payload.openVscode?.target, undefined, "the loopback runtime target must stay server-private");
  assert.equal(payload.stream?.enabled, true);
  assert.equal(payload.stream?.websocketUrl, undefined, "stream bearer URL must not be model-visible");
  const statusContent = status.content as Array<{ type: string; text?: string }>;
  const modelText = statusContent[0]?.type === "text" ? statusContent[0].text ?? "" : "";
  assert.doesNotMatch(modelText, /top-secret-stream-token/);
  assert.doesNotMatch(modelText, /top-secret-ide-token/);
  const ideMeta = status._meta?.[WORKBENCH_IDE_META_KEY] as { ideUrl?: string } | undefined;
  assert.equal(
    ideMeta?.ideUrl,
    "https://editor.example.test/ide/top-secret-ide-token/",
    "the MCP App receives the IDE capability URL through result metadata",
  );
  const streamMeta = status._meta?.[WORKBENCH_STREAM_META_KEY] as { websocketUrl?: string } | undefined;
  assert.equal(
    streamMeta?.websocketUrl,
    "wss://editor.example.test/stream?token=top-secret-stream-token",
    "the MCP App receives the bearer URL through result metadata",
  );
});

test("registerAppResource CSP metadata lists the genuine workbench and stream origin", async (t) => {
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
  const resources = await client.listResources();
  interface CspMeta {
    frameDomains?: string[];
    connectDomains?: string[];
    resourceDomains?: string[];
    baseUriDomains?: string[];
  }
  const meta = (app.contents[0]?._meta as { ui?: { csp?: CspMeta } } | undefined)?.ui?.csp;
  assert.ok(meta, "expected _meta.ui.csp on the resource contents");
  assert.ok(meta!.frameDomains?.includes("https://editor.example.test"), "expected frameDomains on contents[0]._meta.ui.csp");
  assert.ok(meta!.connectDomains?.includes("https://editor.example.test"));
  assert.ok(meta!.connectDomains?.includes("wss://editor.example.test"));
  assert.equal(meta!.resourceDomains, undefined, "the retired local-asset renderer must not widen resource-src");
  assert.equal(meta!.baseUriDomains, undefined, "the App has no external base URI dependency");
  // The second copy of the same CSP block lives in the `registerAppResource`
  // registration metadata itself (as opposed to the resolved contents[0]._meta
  // above); it surfaces through resources/list. Phase 3 (issue #8) must leave
  // both copies byte-identical, including frameDomains.
  const listedResource = resources.resources.find((resource) => resource.uri === "ui://mcp-vscode/workbench.html");
  const listedMeta = (listedResource?._meta as { ui?: { csp?: CspMeta } } | undefined)?.ui?.csp;
  assert.ok(listedMeta, "expected _meta.ui.csp on the listed resource");
  assert.deepEqual(listedMeta, meta, "registerAppResource metadata and contents[0]._meta CSP blocks must stay byte-identical");
});

test("editor tools fail fast when the genuine VS Code bridge is not connected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-mcp-none-"));
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

  for (const name of ["editor_open", "editor_state", "editor_set_selection", "editor_apply_edits", "diagnostics_get"]) {
    const args: Record<string, unknown> =
      name === "editor_open" || name === "editor_set_selection"
        ? { path: "hello.txt", startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }
        : name === "editor_apply_edits"
          ? { path: "hello.txt", edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, text: "x" }] }
          : {};
    const start = Date.now();
    const result = await client.callTool({ name, arguments: args });
    const elapsedMs = Date.now() - start;
    assert.equal(result.isError, true, `expected ${name} to fail without the VS Code bridge`);
    assert.equal(
      (result.structuredContent as { error?: { code?: string } }).error?.code,
      "VSCODE_BRIDGE_UNAVAILABLE",
      `expected ${name} to fail with VSCODE_BRIDGE_UNAVAILABLE`,
    );
    assert.ok(elapsedMs < 2_000, `expected ${name} to fail fast, took ${elapsedMs}ms`);
  }
});

test("VS Code command tools raise VSCODE_BRIDGE_UNAVAILABLE without the genuine bridge", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-mcp-bridge-only-"));
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

  const result = await client.callTool({ name: "vscode_list_commands", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error?: { code?: string } }).error?.code,
    "VSCODE_BRIDGE_UNAVAILABLE",
  );
});
