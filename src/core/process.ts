import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ProcessResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Retain complete UTF-8 characters while enforcing a byte-sized tail limit. */
export function utf8Tail(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
  return encoded.subarray(start).toString("utf8");
}

const terminations = new WeakMap<ChildProcess, Promise<void>>();

/** Only set processGroup for a POSIX child spawned with detached:true. */
export function terminateOwnedProcess(
  child: ChildProcess,
  options: {
    processGroup?: boolean;
    graceMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const previous = terminations.get(child);
  if (previous) return previous;
  const pid = child.pid;
  if (!pid) return Promise.resolve();
  const timeoutMs = options.timeoutMs ?? 2500;
  const graceMs = Math.min(options.graceMs ?? 500, timeoutMs);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(graceMs) ||
    graceMs < 0
  )
    throw new RangeError("Invalid process cleanup timeout");
  const cleanup = new Promise<void>((resolve) => {
    const windows = process.platform === "win32";
    const group = !windows && options.processGroup === true;
    let childClosed =
      (child.exitCode !== null || child.signalCode !== null) &&
      [child.stdout, child.stderr].every(
        (stream) => !stream || stream.destroyed || stream.readableEnded,
      );
    let hardPhaseDone = !group;
    let killerDone = !windows;
    let finished = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let killer: ChildProcess | undefined;
    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (group) process.kill(-pid, signal);
        else if (child.exitCode === null && child.signalCode === null)
          child.kill(signal);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ESRCH" &&
          child.exitCode === null
        )
          child.kill(signal);
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      clearTimeout(deadline);
      child.removeListener("close", onClose);
      resolve();
    };
    const maybeFinish = () => {
      if (childClosed && hardPhaseDone && killerDone) finish();
    };
    const onClose = () => {
      childClosed = true;
      maybeFinish();
    };
    child.once("close", onClose);
    deadline = setTimeout(() => {
      signalTree("SIGKILL");
      killer?.kill("SIGKILL");
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish();
    }, timeoutMs);
    if (windows) {
      // Windows has no portable graceful tree signal; /T /F must run before the parent PID disappears.
      killer = spawn(
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => {
        killerDone = true;
        signalTree("SIGKILL");
        maybeFinish();
      });
      killer.once("close", () => {
        killerDone = true;
        signalTree("SIGKILL");
        maybeFinish();
      });
    } else {
      signalTree("SIGTERM");
      hardTimer = setTimeout(() => {
        signalTree("SIGKILL");
        hardPhaseDone = true;
        maybeFinish();
      }, graceMs);
    }
    maybeFinish();
  });
  terminations.set(child, cleanup);
  return cleanup;
}

export async function runProcess(
  options: ProcessOptions,
): Promise<ProcessResult> {
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new RangeError("Invalid process timeout");
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 8_000_000
  )
    throw new RangeError("Invalid output byte limit");
  options.signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const output = { stdout: "", stderr: "" };
    const truncated = { stdout: false, stderr: false };
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let terminating = false;
    const append = (stream: "stdout" | "stderr", value: string) => {
      const combined = output[stream] + value;
      if (Buffer.byteLength(combined, "utf8") > maxOutputBytes)
        truncated[stream] = true;
      output[stream] = utf8Tail(combined, maxOutputBytes);
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].on("data", (chunk: Buffer) =>
        append(stream, decoders[stream].write(chunk)),
      );
      child[stream].once("end", () => append(stream, decoders[stream].end()));
    }
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        command: options.command,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        ...output,
        timedOut,
        cancelled,
        stdoutTruncated: truncated.stdout,
        stderrTruncated: truncated.stderr,
      });
    };
    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      void terminateOwnedProcess(child, {
        processGroup: process.platform !== "win32",
      }).then(() => finish(child.exitCode, child.signalCode));
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (!terminating) finish(exitCode, signal);
    });
  });
}
