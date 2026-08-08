import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AppToolTransport } from "../src/app/app-tool-transport.js";
import { TransportError } from "../src/app/transport.js";

type ToolCall = { name: string; arguments?: Record<string, unknown> };

function appFrom(handler: (call: ToolCall) => Promise<CallToolResult>): Pick<App, "callServerTool"> {
  return {
    callServerTool: ((call: ToolCall) => handler(call)) as App["callServerTool"],
  };
}

function ok(value: Record<string, unknown>): CallToolResult {
  return { content: [], structuredContent: value };
}

test("maps workspace and terminal RPC methods onto app-visible MCP tools", async () => {
  const calls: ToolCall[] = [];
  const app = appFrom(async (call) => {
    calls.push(call);
    return ok({ called: call.name });
  });
  const transport = new AppToolTransport(app);
  transport.connect();

  const mappings = [
    ["workspace.list", "fs_list"],
    ["workspace.read", "fs_read"],
    ["workspace.write", "fs_write"],
    ["workspace.delete", "fs_delete"],
    ["workspace.move", "fs_move"],
    ["workspace.search", "fs_search"],
    ["terminal.create", "terminal_create"],
    ["terminal.list", "terminal_list"],
    ["terminal.read", "terminal_read"],
    ["terminal.write", "terminal_write"],
    ["terminal.resize", "terminal_resize"],
    ["terminal.close", "terminal_kill"],
  ] as const;

  for (const [method, tool] of mappings) {
    const result = await transport.call(method, { marker: method });
    assert.deepEqual(result, { called: tool });
  }
  assert.deepEqual(calls.map((call) => call.name), mappings.map(([, tool]) => tool));
  assert.deepEqual(calls[0]?.arguments, { marker: "workspace.list" });
  transport.close();
});

test("reports connection state and rejects unknown methods while closed or open", async () => {
  const transport = new AppToolTransport(appFrom(async () => ok({})));
  const statuses: string[] = [];
  let opens = 0;
  transport.onStatusChange = (status) => statuses.push(status);
  transport.onOpen(() => { opens += 1; });

  await assert.rejects(
    transport.call("workspace.list", {}),
    (error: unknown) => error instanceof TransportError && error.code === "NOT_CONNECTED",
  );
  transport.connect();
  assert.equal(transport.isOpen, true);
  assert.equal(opens, 1);
  await assert.rejects(
    transport.call("not.real", {}),
    (error: unknown) => error instanceof TransportError && error.code === "METHOD_NOT_FOUND",
  );
  transport.close();
  assert.equal(transport.isOpen, false);
  assert.deepEqual(statuses, ["open", "closed"]);
});

test("turns structured MCP tool errors into TransportError", async () => {
  const transport = new AppToolTransport(appFrom(async () => ({
    isError: true,
    content: [{ type: "text", text: "write failed" }],
    structuredContent: {
      error: { code: "VERSION_CONFLICT", message: "File changed", details: { actual: "new" } },
    },
  })));
  transport.connect();

  await assert.rejects(
    transport.call("workspace.write", { path: "a.txt", content: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.code, "VERSION_CONFLICT");
      assert.equal(error.message, "File changed");
      assert.deepEqual(error.details, { actual: "new" });
      return true;
    },
  );
  transport.close();
});

test("falls back to JSON text content when structuredContent is omitted", async () => {
  const transport = new AppToolTransport(appFrom(async () => ({
    content: [{ type: "text", text: JSON.stringify({ entries: [{ path: "README.md" }] }) }],
  })));
  transport.connect();
  assert.deepEqual(await transport.call("workspace.list", {}), { entries: [{ path: "README.md" }] });
  transport.close();
});

test("terminal.attach polls terminal_read and emits only new output plus one exit", async () => {
  const snapshots = [
    { id: "terminal-1", output: "hello", state: "running" },
    { id: "terminal-1", output: "hello world", state: "running" },
    { id: "terminal-1", output: "hello world", state: "exited", exitCode: 0 },
  ];
  let readIndex = 0;
  const app = appFrom(async (call) => {
    assert.equal(call.name, "terminal_read");
    const snapshot = snapshots[Math.min(readIndex, snapshots.length - 1)]!;
    readIndex += 1;
    return ok(snapshot);
  });
  const transport = new AppToolTransport(app, { pollIntervalMs: 2 });
  const output: string[] = [];
  const exits: unknown[] = [];
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  transport.on((event) => {
    if (event.event === "terminal.output") output.push((event.data as { data: string }).data);
    if (event.event === "terminal.exited") {
      exits.push(event.data);
      resolveExit();
    }
  });
  transport.connect();

  await transport.call("terminal.attach", { id: "terminal-1" });
  await Promise.race([
    exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("terminal poll timed out")), 500)),
  ]);
  transport.close();

  assert.equal(output.join(""), "hello world");
  assert.equal(exits.length, 1);
  assert.deepEqual(exits[0], snapshots[2]);
});
