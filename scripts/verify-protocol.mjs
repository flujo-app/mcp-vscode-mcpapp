import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const entry = resolve(process.argv[2] ?? "dist/cli.js");
for (const modern of [true, false]) {
  const workspace = await mkdtemp(join(tmpdir(), "vscode-protocol-"));
  const child = spawn(
    process.execPath,
    [
      entry,
      "--stdio",
      "--workspace",
      workspace,
      "--state-dir",
      join(workspace, "state"),
      ...(process.env.MCP_VSCODE_REAL_RUNTIME_ROOT
        ? ["--openvscode-root", process.env.MCP_VSCODE_REAL_RUNTIME_ROOT]
        : ["--ide-url", "http://127.0.0.1:9"]),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "",
    next = 1;
  const pending = new Map();
  child.stderr.on("data", (c) => (stderr += c));
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const found = pending.get(message.id);
      if (found) {
        pending.delete(message.id);
        found.resolve(message);
      }
    } catch (error) {
      for (const p of pending.values())
        p.reject(new Error("Non-JSON stdout: " + line, { cause: error }));
    }
  });
  child.on("error", (error) => {
    for (const p of pending.values()) p.reject(error);
  });
  child.on("exit", () => {
    for (const p of pending.values())
      p.reject(new Error("Unexpected exit: " + stderr));
  });
  function rpc(method, params = {}) {
    const id = next++;
    if (modern)
      params = {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Timeout: " + method + "; " + stderr));
      }, 15000);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  try {
    const hello = modern
      ? await rpc("server/discover")
      : await rpc("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "packed-vscode-gate", version: "1" },
        });
    assert.equal(hello.error, undefined);
    if (modern) assert.equal(hello.result.resultType, "complete");
    else assert.equal(hello.result.serverInfo.name, "mcp-vscode");
    if (!modern)
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
    const list = await rpc("tools/list");
    assert.ok(list.result.tools.some((t) => t.name === "terminal_run"));
    if (modern) {
      assert.equal(list.result.resultType, "complete");
      assert.equal(typeof list.result.ttlMs, "number");
      assert.ok(list.result.cacheScope);
    }
    const written = await rpc("tools/call", {
      name: "fs_write",
      arguments: { path: "unicode.txt", content: "VS Code — ✓" },
    });
    assert.equal(written.error, undefined);
    assert.notEqual(written.result.isError, true);
    const read = await rpc("tools/call", {
      name: "fs_read",
      arguments: { path: "unicode.txt" },
    });
    assert.equal(read.result.structuredContent.content, "VS Code — ✓");
    const run = await rpc("tools/call", {
      name: "terminal_run",
      arguments: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('one-shot — ✓')"],
        timeoutMs: 5000,
      },
    });
    assert.equal(run.error, undefined);
    assert.equal(run.result.structuredContent.exitCode, 0);
    assert.equal(run.result.structuredContent.stdout, "one-shot — ✓");
    const ui = await rpc("resources/read", {
      uri: "ui://mcp-vscode/workbench.html",
    });
    assert.equal(ui.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok(ui.result.contents[0].text.length > 1000);
    const escaped = await rpc("tools/call", {
      name: "fs_read",
      arguments: { path: "../outside.txt" },
    });
    assert.ok(escaped.error || escaped.result?.isError);
    const invalid = await rpc("tools/call", { name: "fs_read", arguments: {} });
    assert.ok(invalid.error || invalid.result?.isError);
    const unknown = await rpc("tools/call", {
      name: "does-not-exist",
      arguments: {},
    });
    assert.ok(unknown.error || unknown.result?.isError);
    child.stdin.end();
    const closed = await Promise.race([
      exited,
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("EOF did not shut down")),
          5000,
        );
        t.unref();
      }),
    ]);
    assert.equal(closed[0], 0, stderr);
    console.log(
      (modern ? "2026-07-28" : "2025-11-25") +
        ": actual VS Code filesystem, terminal execution, Apps, errors and clean EOF passed",
    );
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}
