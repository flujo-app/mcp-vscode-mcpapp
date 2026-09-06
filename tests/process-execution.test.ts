import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { runProcess, terminateOwnedProcess } from "../src/core/process.js";

test("one-shot process preserves argv and split UTF-8 on independent streams", async () => {
  const script =
    "const b=Buffer.from('—✓😀');let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));process.stderr.write(b.subarray(i,i+1));if(++i===b.length){clearInterval(t)}},5)";
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
  });
  assert.equal(result.stdout, "—✓😀");
  assert.equal(result.stderr, "—✓😀");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  const argv = [
    "hello world",
    "x; echo SHOULD_NOT_EXECUTE",
    "$(echo literal)",
    "✓",
  ];
  const echoed = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...argv,
    ],
    cwd: process.cwd(),
  });
  assert.deepEqual(JSON.parse(echoed.stdout), argv);
});

test("one-shot output has a byte bound without broken Unicode", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('✓'.repeat(100));process.stderr.write('😀'.repeat(100))",
    ],
    cwd: process.cwd(),
    maxOutputBytes: 10,
  });
  assert.ok(Buffer.byteLength(result.stdout) <= 10);
  assert.ok(Buffer.byteLength(result.stderr) <= 10);
  assert.doesNotMatch(result.stdout + result.stderr, /�/);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("deadline terminates the owned process tree even when SIGTERM is ignored", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heartbeat = path.join(root, "heartbeat.txt");
  const descendant =
    "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),20)";
  const script =
    "const cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e'," +
    JSON.stringify(descendant) +
    ",process.argv[1]],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const start = Date.now();
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", script, heartbeat],
    cwd: root,
    timeoutMs: 700,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - start < 4000);
  const stopped = await readFile(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    await readFile(heartbeat, "utf8"),
    stopped,
    "descendant heartbeat stops too",
  );
});

test("cancellation is distinct from a timeout and spawn failures reject", async () => {
  const controller = new AbortController();
  const running = runProcess({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  await assert.rejects(
    runProcess({
      command: "mcp-vscode-definitely-missing-command",
      cwd: process.cwd(),
    }),
  );
});

test("deadline also reaps an ignoring descendant when its parent exits immediately", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-child-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heartbeat = path.join(root, "heartbeat.txt");
  const descendant =
    "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),20)";
  const script =
    "require('node:child_process').spawn(process.execPath,['-e'," +
    JSON.stringify(descendant) +
    ",process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000)";
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", script, heartbeat],
    cwd: root,
    timeoutMs: 700,
  });
  assert.equal(result.timedOut, true);
  const stopped = await readFile(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await readFile(heartbeat, "utf8"), stopped);
});

test("shared cleanup closes a descendant socket after its POSIX launcher has exited", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX launcher process-group regression");
    return;
  }
  const descendant =
    "process.on('SIGTERM',()=>{});const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port})))";
  const launcher =
    "require('node:child_process').spawn(process.execPath,['-e'," +
    JSON.stringify(descendant) +
    "],{stdio:'inherit'});process.exit(0)";
  const child = spawn(process.execPath, ["-e", launcher], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => terminateOwnedProcess(child, { processGroup: true }));
  let stdout = "";
  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });
  await once(child, "exit");
  for (let count = 0; count < 100 && !stdout.includes("\n"); count++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const { port } = JSON.parse(stdout.trim());
  const canConnect = () =>
    new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(300, () => {
        socket.destroy();
        resolve(false);
      });
    });
  assert.equal(await canConnect(), true);
  assert.equal(
    child.stdout.readableEnded,
    false,
    "descendant retains the launcher pipe",
  );
  await terminateOwnedProcess(child, { processGroup: true });
  assert.equal(await canConnect(), false);
  assert.equal(child.stdout.destroyed, true);
});
