import assert from "node:assert/strict";
import test from "node:test";
import { CoreEvents } from "../src/core/events.js";
import { TerminalManager } from "../src/core/terminal.js";

test("terminal manager captures process output", async (t) => {
  process.env.MCP_VSCODE_DISABLE_PTY = "1";
  t.after(() => delete process.env.MCP_VSCODE_DISABLE_PTY);
  const manager = new TerminalManager(new CoreEvents());
  t.after(() => manager.closeAll());
  const terminal = await manager.create({
    cwd: process.cwd(),
    shell: process.execPath,
    args: ["-e", "process.stdout.write('terminal-ok')"],
    name: "test",
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && manager.read(terminal.id).state === "running") {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const result = manager.read(terminal.id);
  assert.match(result.output, /terminal-ok/);
  assert.equal(result.state, "exited");
  assert.equal(result.exitCode, 0);
});
