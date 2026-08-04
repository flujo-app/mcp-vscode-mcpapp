import { spawn } from "node:child_process";

export interface ProcessResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runProcess(options: {
  command: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => {
      const combined = current + chunk.toString("utf8");
      if (Buffer.byteLength(combined, "utf8") <= maxOutputBytes) return combined;
      return combined.slice(-maxOutputBytes);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: options.command,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}
