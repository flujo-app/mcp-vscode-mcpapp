import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { CoreEvents } from "./events.js";
import { McpVscodeError } from "./errors.js";

interface PtyLike {
  pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  pid: number;
  createdAt: string;
  state: "running" | "exited";
  exitCode?: number;
  output: string;
  pty?: PtyLike;
  child?: ChildProcessWithoutNullStreams;
  disposables?: Array<{ dispose(): void }>;
}

export interface TerminalSummary {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  pid: number;
  createdAt: string;
  state: "running" | "exited";
  exitCode?: number;
}

const MAX_OUTPUT = 2_000_000;

export class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #events: CoreEvents;
  #ptyModule?: typeof import("node-pty") | null;

  constructor(events: CoreEvents) {
    this.#events = events;
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
  }): Promise<TerminalSummary & { backend: "pty" | "pipes" }> {
    const id = randomUUID();
    const shell = options.shell ?? defaultShell();
    const args = options.args ?? defaultShellArgs(shell);
    const base = {
      id,
      name: options.name ?? `Terminal ${this.#sessions.size + 1}`,
      cwd: options.cwd,
      shell,
      createdAt: new Date().toISOString(),
      state: "running" as const,
      output: "",
    };
    const ptyModule = await this.#loadPty();
    if (ptyModule) {
      const pty = ptyModule.spawn(shell, args, {
        name: "xterm-256color",
        cwd: options.cwd,
        cols: options.columns ?? 120,
        rows: options.rows ?? 30,
        env: { ...process.env, ...options.env } as Record<string, string>,
      }) as PtyLike;
      const session: TerminalSession = { ...base, pid: pty.pid, pty, disposables: [] };
      this.#sessions.set(id, session);
      session.disposables?.push(pty.onData((data) => this.#onData(session, data)));
      session.disposables?.push(pty.onExit(({ exitCode }) => this.#onExit(session, exitCode)));
      this.#events.emit("terminal.created", {
        ...this.#summary(session),
        ...(options.requestId ? { requestId: options.requestId } : {}),
      });
      return { ...this.#summary(session), backend: "pty" };
    }

    const child = spawnChild(shell, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: TerminalSession = { ...base, pid: child.pid ?? -1, child };
    this.#sessions.set(id, session);
    child.stdout.on("data", (data: Buffer) => this.#onData(session, data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => this.#onData(session, data.toString("utf8")));
    child.on("exit", (code) => this.#onExit(session, code ?? -1));
    this.#events.emit("terminal.created", {
      ...this.#summary(session),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    return { ...this.#summary(session), backend: "pipes" };
  }

  list(): TerminalSummary[] {
    return [...this.#sessions.values()].map((session) => this.#summary(session));
  }

  read(id: string, tailCharacters = 20_000): TerminalSummary & { output: string } {
    const session = this.#get(id);
    return {
      ...this.#summary(session),
      output: session.output.slice(-Math.min(tailCharacters, MAX_OUTPUT)),
    };
  }

  write(id: string, data: string): { id: string; written: number } {
    const session = this.#getRunning(id);
    if (session.pty) session.pty.write(data);
    else session.child?.stdin.write(data);
    this.#events.emit("terminal.input", { id, length: data.length });
    return { id, written: data.length };
  }

  resize(id: string, columns: number, rows: number): { id: string; columns: number; rows: number } {
    const session = this.#getRunning(id);
    session.pty?.resize(columns, rows);
    return { id, columns, rows };
  }

  kill(id: string): { id: string; killed: true } {
    const session = this.#getRunning(id);
    if (session.pty) session.pty.kill();
    else session.child?.kill();
    return { id, killed: true };
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) {
      if (session.state !== "running") continue;
      if (session.pty) session.pty.kill();
      else session.child?.kill();
    }
    this.#sessions.clear();
  }

  async #loadPty(): Promise<typeof import("node-pty") | null> {
    if (process.env.MCP_VSCODE_DISABLE_PTY === "1") return null;
    if (this.#ptyModule !== undefined) return this.#ptyModule;
    try {
      this.#ptyModule = await import("node-pty");
    } catch {
      this.#ptyModule = null;
    }
    return this.#ptyModule;
  }

  #get(id: string): TerminalSession {
    const session = this.#sessions.get(id);
    if (!session) throw new McpVscodeError(`Unknown terminal: ${id}`, "TERMINAL_NOT_FOUND");
    return session;
  }

  #getRunning(id: string): TerminalSession {
    const session = this.#get(id);
    if (session.state !== "running") {
      throw new McpVscodeError(`Terminal has exited: ${id}`, "TERMINAL_EXITED");
    }
    return session;
  }

  #onData(session: TerminalSession, data: string): void {
    session.output = (session.output + data).slice(-MAX_OUTPUT);
    this.#events.emit("terminal.output", { id: session.id, data });
  }

  #onExit(session: TerminalSession, exitCode: number): void {
    session.state = "exited";
    session.exitCode = exitCode;
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
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    };
  }
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC ?? "powershell.exe";
  return process.env.SHELL ?? (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
}

function defaultShellArgs(shell: string): string[] {
  const lower = shell.toLowerCase();
  if (lower.endsWith("powershell.exe") || lower.endsWith("pwsh.exe")) return ["-NoLogo"];
  return ["-l"];
}
