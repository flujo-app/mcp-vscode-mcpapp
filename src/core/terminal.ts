import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { CoreEvents } from "./events.js";
import { McpVscodeError } from "./errors.js";
import {
  runProcess,
  terminateOwnedProcess,
  utf8Tail,
  type ProcessOptions,
  type ProcessResult,
} from "./process.js";

interface PtyLike {
  pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
}
// Optional native dependencies must not be needed to typecheck a pipes-only installation.
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cwd: string;
      cols: number;
      rows: number;
      env: Record<string, string>;
      encoding?: string;
    },
  ): PtyLike;
}
type Readiness = "process-started" | "output-observed" | "exited";
interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  pid: number;
  createdAt: string;
  state: "running" | "exited";
  readiness: Readiness;
  exitCode?: number;
  output: string;
  firstOutput: Promise<void>;
  resolveOutput(): void;
  pty?: PtyLike;
  child?: ChildProcessWithoutNullStreams;
  disposables?: Array<{ dispose(): void }>;
  cleanup?: Promise<void>;
}
export interface TerminalSummary {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  pid: number;
  createdAt: string;
  state: "running" | "exited";
  readiness: Readiness;
  exitCode?: number;
}
const MAX_OUTPUT = 2_000_000;

export class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #events: CoreEvents;
  #ptyModule?: PtyModule | null;
  constructor(events: CoreEvents) {
    this.#events = events;
  }

  async run(options: ProcessOptions): Promise<ProcessResult> {
    return await runProcess(options);
  }

  async create(options: {
    cwd: string;
    shell?: string;
    args?: string[];
    name?: string;
    columns?: number;
    rows?: number;
    env?: Record<string, string>;
    requestId?: string;
    waitForOutputMs?: number;
  }): Promise<TerminalSummary & { backend: "pty" | "pipes" }> {
    const waitForOutputMs = options.waitForOutputMs ?? 1000;
    if (
      !Number.isInteger(waitForOutputMs) ||
      waitForOutputMs < 0 ||
      waitForOutputMs > 5000
    )
      throw new McpVscodeError(
        "Invalid initial output wait",
        "INVALID_TERMINAL_OPTIONS",
      );
    const id = randomUUID();
    const shell = options.shell ?? defaultShell();
    const args = options.args ?? defaultShellArgs(shell);
    let resolveOutput!: () => void;
    const firstOutput = new Promise<void>((resolve) => {
      resolveOutput = resolve;
    });
    const base = {
      id,
      name: options.name ?? `Terminal ${this.#sessions.size + 1}`,
      cwd: options.cwd,
      shell,
      createdAt: new Date().toISOString(),
      state: "running" as const,
      readiness: "process-started" as const,
      output: "",
      firstOutput,
      resolveOutput,
    };
    const ptyModule = await this.#loadPty();
    let session: TerminalSession;
    let backend: "pty" | "pipes";
    if (ptyModule) {
      const pty = ptyModule.spawn(shell, args, {
        name: "xterm-256color",
        cwd: options.cwd,
        cols: options.columns ?? 120,
        rows: options.rows ?? 30,
        env: { ...process.env, ...options.env } as Record<string, string>,
        ...(process.platform === "win32" ? {} : { encoding: "utf8" }),
      });
      session = { ...base, pid: pty.pid, pty, disposables: [] };
      this.#sessions.set(id, session);
      session.disposables?.push(
        pty.onData((data) => this.#onData(session, data)),
      );
      session.disposables?.push(
        pty.onExit(({ exitCode }) => this.#onExit(session, exitCode)),
      );
      backend = "pty";
    } else {
      const child = spawnChild(shell, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      session = { ...base, pid: child.pid ?? -1, child };
      this.#sessions.set(id, session);
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8");
        stream.on("data", (data: Buffer) =>
          this.#onData(session, decoder.write(data)),
        );
        stream.once("end", () => this.#onData(session, decoder.end()));
      }
      child.once("close", (code) => this.#onExit(session, code ?? -1));
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      } catch (error) {
        this.#sessions.delete(id);
        throw error;
      }
      backend = "pipes";
    }
    this.#events.emit("terminal.created", {
      ...this.#summary(session),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    // Output can be a banner rather than a prompt. Report the observation, not a prompt-ready claim.
    if (waitForOutputMs && session.readiness === "process-started") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.firstOutput,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitForOutputMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return { ...this.#summary(session), backend };
  }

  list(): TerminalSummary[] {
    return [...this.#sessions.values()].map((session) =>
      this.#summary(session),
    );
  }

  read(
    id: string,
    tailCharacters = 20_000,
    options: { stripAnsi?: boolean } = {},
  ): TerminalSummary & { output: string } {
    const session = this.#get(id);
    const output =
      (options.stripAnsi ?? true)
        ? stripVTControlCharacters(session.output)
        : session.output;
    return {
      ...this.#summary(session),
      output: output.slice(-Math.min(Math.max(1, tailCharacters), MAX_OUTPUT)),
    };
  }

  write(
    id: string,
    data: string,
    options: { submit?: boolean } = {},
  ): { id: string; written: number } {
    const session = this.#getRunning(id);
    const ending = session.pty
      ? "\r"
      : process.platform === "win32"
        ? "\r\n"
        : "\n";
    const input = options.submit ? data.replace(/[\r\n]+$/, "") + ending : data;
    if (session.pty) session.pty.write(input);
    else session.child?.stdin.write(input);
    this.#events.emit("terminal.input", { id, length: input.length });
    return { id, written: input.length };
  }

  resize(
    id: string,
    columns: number,
    rows: number,
  ): { id: string; columns: number; rows: number } {
    const session = this.#getRunning(id);
    session.pty?.resize(columns, rows);
    return { id, columns, rows };
  }
  async kill(id: string): Promise<{ id: string; killed: true }> {
    const session = this.#getRunning(id);
    await this.#terminate(session);
    return { id, killed: true };
  }
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((session) => this.#terminate(session)),
    );
    this.#sessions.clear();
  }
  #terminate(session: TerminalSession): Promise<void> {
    if (session.cleanup) return session.cleanup;
    session.resolveOutput();
    if (session.child) {
      session.cleanup = terminateOwnedProcess(session.child, {
        processGroup: process.platform !== "win32",
      });
    } else if (session.pty) {
      const pty = session.pty;
      // forkpty creates a POSIX session/process group. Bound cleanup even if the shell ignores HUP.
      // On Windows node-pty closes its owned ConPTY agent and console process tree.
      session.cleanup = new Promise<void>((resolve) => {
        if (process.platform === "win32") {
          try {
            pty.kill();
          } catch {}
          resolve();
          return;
        }
        try {
          process.kill(-pty.pid, "SIGHUP");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            resolve();
            return;
          }
          try {
            pty.kill("SIGHUP");
          } catch {}
        }
        setTimeout(() => {
          try {
            process.kill(-pty.pid, "SIGKILL");
          } catch {}
          resolve();
        }, 500);
      });
    } else session.cleanup = Promise.resolve();
    return session.cleanup;
  }
  async #loadPty(): Promise<PtyModule | null> {
    if (process.env.MCP_VSCODE_DISABLE_PTY === "1") return null;
    if (this.#ptyModule !== undefined) return this.#ptyModule;
    try {
      const moduleName = "node-pty";
      this.#ptyModule = (await import(moduleName)) as PtyModule;
    } catch {
      this.#ptyModule = null;
    }
    return this.#ptyModule;
  }
  #get(id: string): TerminalSession {
    const session = this.#sessions.get(id);
    if (!session)
      throw new McpVscodeError(`Unknown terminal: ${id}`, "TERMINAL_NOT_FOUND");
    return session;
  }
  #getRunning(id: string): TerminalSession {
    const session = this.#get(id);
    if (session.state !== "running")
      throw new McpVscodeError(`Terminal has exited: ${id}`, "TERMINAL_EXITED");
    return session;
  }
  #onData(session: TerminalSession, data: string): void {
    if (!data) return;
    session.output = utf8Tail(session.output + data, MAX_OUTPUT);
    if (session.state === "running") session.readiness = "output-observed";
    session.resolveOutput();
    this.#events.emit("terminal.output", { id: session.id, data });
  }
  #onExit(session: TerminalSession, exitCode: number): void {
    session.state = "exited";
    session.readiness = "exited";
    session.exitCode = exitCode;
    session.resolveOutput();
    for (const disposable of session.disposables ?? []) disposable.dispose();
    session.disposables = [];
    session.pty = undefined;
    session.child = undefined;
    this.#events.emit("terminal.exited", this.#summary(session));
  }
  #summary(session: TerminalSession): TerminalSummary {
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pid,
      createdAt: session.createdAt,
      state: session.state,
      readiness: session.readiness,
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    };
  }
}

function defaultShell(): string {
  if (process.platform === "win32")
    return process.env.COMSPEC ?? "powershell.exe";
  return (
    process.env.SHELL ?? (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash")
  );
}
export function defaultShellArgs(shell: string): string[] {
  const name = shell.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (name === "cmd.exe" || name === "cmd")
    return ["/D", "/K", "chcp 65001>nul"];
  if (
    ["powershell.exe", "powershell", "pwsh.exe", "pwsh"].includes(name ?? "")
  ) {
    return [
      "-NoLogo",
      "-NoProfile",
      "-NoExit",
      "-Command",
      "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); " +
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding",
    ];
  }
  return ["-l"];
}
