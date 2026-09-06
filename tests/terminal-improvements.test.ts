import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import { CoreEvents } from "../src/core/events.js";
import { TerminalManager } from "../src/core/terminal.js";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string) {
  for (let index = 0; index < 200; index++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(message);
}
function managerFor(t: test.TestContext, pipes: boolean) {
  const old = process.env.MCP_VSCODE_DISABLE_PTY;
  if (pipes) process.env.MCP_VSCODE_DISABLE_PTY = "1";
  else delete process.env.MCP_VSCODE_DISABLE_PTY;
  const manager = new TerminalManager(new CoreEvents());
  t.after(async () => {
    await manager.closeAll();
    if (old === undefined) delete process.env.MCP_VSCODE_DISABLE_PTY;
    else process.env.MCP_VSCODE_DISABLE_PTY = old;
  });
  return manager;
}

test("pipes decode split UTF-8 and strip CSI/OSC by default while retaining raw output", async (t) => {
  const manager = managerFor(t, true);
  const terminal = await manager.create({
    cwd: process.cwd(),
    shell: process.execPath,
    args: [
      "-e",
      "const b=Buffer.from('\\u001b[2J\\u001b]0;title\\u0007—✓😀\\u001b[0m');let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},4)",
    ],
  });
  await until(
    () => manager.read(terminal.id).state === "exited",
    "pipe child exits",
  );
  assert.equal(manager.read(terminal.id).output, "—✓😀");
  assert.match(
    manager.read(terminal.id, 20_000, { stripAnsi: false }).output,
    /\u001b/,
  );
  assert.equal(manager.read(terminal.id).readiness, "exited");
});

test("raw writes and submit have distinct behavior and failed spawns leave no session", async (t) => {
  const manager = managerFor(t, true);
  const terminal = await manager.create({
    cwd: process.cwd(),
    shell: process.execPath,
    args: [
      "-e",
      "process.stdout.write('READY\\n');let b='';process.stdin.on('data',d=>{b+=d;if(b.includes('\\n')){process.stdout.write('ACK:'+b);process.exit(0)}})",
    ],
  });
  assert.equal(terminal.readiness, "output-observed");
  manager.write(terminal.id, "hello —✓");
  await delay(50);
  assert.doesNotMatch(manager.read(terminal.id).output, /ACK/);
  manager.write(terminal.id, "", { submit: true });
  await until(
    () => manager.read(terminal.id).state === "exited",
    "submitted pipe child exits",
  );
  assert.match(manager.read(terminal.id).output, /ACK:hello —✓/);
  const count = manager.list().length;
  await assert.rejects(
    manager.create({ cwd: process.cwd(), shell: "mcp-vscode-missing-shell" }),
  );
  assert.equal(manager.list().length, count);
});

test("silent processes expose bounded process-started readiness", async (t) => {
  const manager = managerFor(t, true);
  const terminal = await manager.create({
    cwd: process.cwd(),
    shell: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    waitForOutputMs: 20,
  });
  assert.equal(terminal.readiness, "process-started");
});

test("real native PTY handles UTF-8, ANSI and an explicit submitted line", async (t) => {
  const manager = managerFor(t, false);
  const terminal = await manager.create({
    cwd: process.cwd(),
    shell: process.execPath,
    args: [
      "-e",
      "process.stdout.write('\\u001b]0;native\\u0007READY\\n');process.stdin.on('data',d=>{process.stdout.write('ACK:'+d);process.exit(0)})",
    ],
  });
  if (
    terminal.backend !== "pty" &&
    process.env.MCP_VSCODE_REQUIRE_PTY !== "1"
  ) {
    t.skip("optional native PTY unavailable");
    return;
  }
  assert.equal(terminal.backend, "pty");
  assert.equal(terminal.readiness, "output-observed");
  manager.write(terminal.id, "héllo —✓😀", { submit: true });
  await until(
    () => manager.read(terminal.id).output.includes("ACK:héllo —✓😀"),
    "native PTY receives submitted Unicode",
  );
  assert.doesNotMatch(manager.read(terminal.id).output, /\u001b|�/);
  assert.match(
    manager.read(terminal.id, 20_000, { stripAnsi: false }).output,
    /\u001b/,
  );
});

test("real default shell initialization executes submitted commands", async (t) => {
  const shells =
    process.platform === "win32"
      ? ["cmd.exe", "powershell.exe"]
      : ["/bin/bash"];
  for (const shell of shells) {
    const manager = managerFor(t, false);
    const terminal = await manager.create({
      cwd: process.cwd(),
      shell,
      waitForOutputMs: 2000,
    });
    if (
      terminal.backend !== "pty" &&
      process.env.MCP_VSCODE_REQUIRE_PTY !== "1"
    ) {
      t.skip("optional native PTY unavailable");
      return;
    }
    assert.equal(terminal.backend, "pty");
    const dir=await mkdtemp(join(tmpdir(),"vscode-shell-"));const output=join(dir,"unicode.txt");
    t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const value="MCP_SUBMIT_—_✓";
    const command=shell==="cmd.exe"?`echo ${value}>"${output}" & type "${output}"`:
      shell==="powershell.exe"?`Set-Content -LiteralPath '${output.replaceAll("'","''")}' -Value '${value}' -Encoding utf8; Get-Content -LiteralPath '${output.replaceAll("'","''")}'`:
      `printf '%s\\n' '${value}' > '${output.replaceAll("'", "'\\''")}'; cat '${output.replaceAll("'", "'\\''")}'`;
    manager.write(terminal.id,command,{submit:true});
    await until(()=>{try{return readFileSync(output,"utf8").replace(/^\uFEFF/,"").trim()===value;}catch{return false;}},shell+" executes a submitted Unicode command and writes its actual result");
    assert.ok(manager.read(terminal.id).output.includes(value));
    await manager.kill(terminal.id);
  }
});

for (const pipes of [true, false])
  test(`closing ${pipes ? "pipe" : "native PTY"} terminal kills an uncooperative owned descendant`, async (t) => {
    const manager = managerFor(t, pipes);
    const source =
      "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});process.stdout.write('CHILD:'+c.pid+'\\n');process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const terminal = await manager.create({
      cwd: process.cwd(),
      shell: process.execPath,
      args: ["-e", source],
    });
    if (
      !pipes &&
      terminal.backend !== "pty" &&
      process.env.MCP_VSCODE_REQUIRE_PTY !== "1"
    ) {
      t.skip("optional native PTY unavailable");
      return;
    }
    assert.equal(terminal.backend, pipes ? "pipes" : "pty");
    await until(
      () => /CHILD:\d+/.test(manager.read(terminal.id).output),
      "descendant starts",
    );
    const pid = Number(
      manager.read(terminal.id).output.match(/CHILD:(\d+)/)![1],
    );
    t.after(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    });
    await manager.closeAll();
    const alive = async () => {
      // Linux PID1 may retain a dead zombie; it cannot execute or hold descriptors.
      if (process.platform === "linux") {
        try {
          return !(
            await (
              await import("node:fs/promises")
            ).readFile(`/proc/${pid}/stat`, "utf8")
          )
            .split(") ")[1]!
            .startsWith("Z");
        } catch {
          return false;
        }
      }
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && (await alive()); i++) await delay(25);
    assert.equal(await alive(), false, "owned descendant stops");
  });
