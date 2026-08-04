import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, cp, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpVscodeError } from "../core/errors.js";
import type { VscodeCore } from "../core/core.js";

export type OpenVscodeState = "stopped" | "starting" | "ready" | "unavailable" | "failed";

export interface OpenVscodeStatus {
  state: OpenVscodeState;
  target?: string;
  browserUrl?: string;
  executable?: string;
  pid?: number;
  error?: string;
  logs: string[];
  basePath?: string;
}

export interface OpenVscodeLaunch {
  executable: string;
  prefixArgs: string[];
  shell: boolean;
}

export class OpenVscodeRuntime {
  readonly #core: VscodeCore;
  readonly #workspaceRoot: string;
  readonly #stateRoot: string;
  readonly #configuredRoot?: string;
  readonly #externalIdeUrl?: string;
  readonly #basePath = `/ide/${randomBytes(24).toString("base64url")}`;
  #state: OpenVscodeState = "stopped";
  #target?: string;
  #browserUrl?: string;
  #executable?: string;
  #launchPrefixArgs: string[] = [];
  #launchShell = false;
  #process?: ChildProcess;
  #error?: string;
  #logs: string[] = [];

  constructor(options: {
    core: VscodeCore;
    workspaceRoot: string;
    stateRoot?: string;
    openVscodeRoot?: string;
    externalIdeUrl?: string;
  }) {
    this.#core = options.core;
    this.#workspaceRoot = options.workspaceRoot;
    this.#stateRoot = options.stateRoot ?? path.join(options.workspaceRoot, ".mcp-vscode");
    this.#configuredRoot = options.openVscodeRoot;
    this.#externalIdeUrl = options.externalIdeUrl;
  }

  get target(): string | undefined {
    return this.#target;
  }

  get basePath(): string {
    return this.#basePath;
  }

  async start(options: { gatewayOrigin: string; bridgeUrl: string }): Promise<OpenVscodeStatus> {
    if (this.#externalIdeUrl) {
      this.#state = "ready";
      this.#target = this.#externalIdeUrl;
      this.#browserUrl = `${options.gatewayOrigin}${this.#basePath}/`;
      return this.status();
    }
    this.#state = "starting";
    this.#error = undefined;
    try {
      const launch = await this.#findLaunch();
      this.#executable = launch.executable;
      this.#launchPrefixArgs = launch.prefixArgs;
      this.#launchShell = launch.shell;
    } catch (error) {
      this.#state = "unavailable";
      this.#error = error instanceof Error ? error.message : String(error);
      return this.status();
    }

    await mkdir(this.#stateRoot, { recursive: true });
    const extensionsDir = path.join(this.#stateRoot, "extensions");
    const serverDataDir = path.join(this.#stateRoot, "server-data");
    await mkdir(extensionsDir, { recursive: true });
    await mkdir(serverDataDir, { recursive: true });
    await this.#installBridgeExtension(extensionsDir);

    const port = await getFreePort();
    this.#target = `http://127.0.0.1:${port}`;
    this.#browserUrl = `${options.gatewayOrigin}${this.#basePath}/`;
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--server-base-path",
      this.#basePath,
      "--without-connection-token",
      "--server-data-dir",
      serverDataDir,
      "--extensions-dir",
      extensionsDir,
      "--default-folder",
      this.#workspaceRoot,
    ];
    const command = this.#executable;
    this.#process = spawn(command, [...this.#launchPrefixArgs, ...args], {
      cwd: this.#workspaceRoot,
      env: {
        ...process.env,
        MCP_VSCODE_BRIDGE_URL: options.bridgeUrl,
        MCP_VSCODE_BRIDGE_TOKEN: this.#core.bridgeToken,
      },
      windowsHide: true,
      shell: this.#launchShell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#process.stdout?.on("data", (data: Buffer) => this.#log(data.toString("utf8")));
    this.#process.stderr?.on("data", (data: Buffer) => this.#log(data.toString("utf8")));
    this.#process.once("exit", (code, signal) => {
      if (this.#state === "stopped") return;
      this.#state = "failed";
      this.#error = `OpenVSCode exited with code ${String(code)} and signal ${String(signal)}`;
      this.#core.events.emit("openvscode.exited", { code, signal });
    });
    this.#process.once("error", (error) => {
      this.#state = "failed";
      this.#error = error.message;
      this.#core.events.emit("openvscode.error", { message: error.message });
    });

    try {
      await waitForHttp(`${this.#target}${this.#basePath}/`, 30_000);
      this.#state = "ready";
      this.#core.events.emit("openvscode.ready", { browserUrl: this.#browserUrl });
    } catch (error) {
      this.#state = "failed";
      this.#error = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }

  status(): OpenVscodeStatus {
    return {
      state: this.#state,
      ...(this.#target ? { target: this.#target } : {}),
      ...(this.#browserUrl ? { browserUrl: this.#browserUrl } : {}),
      ...(this.#executable ? { executable: this.#executable } : {}),
      ...(this.#process?.pid ? { pid: this.#process.pid } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      logs: [...this.#logs],
      basePath: this.#basePath,
    };
  }

  close(): void {
    this.#state = "stopped";
    this.#process?.kill("SIGTERM");
    this.#process = undefined;
  }

  async #findLaunch(): Promise<OpenVscodeLaunch> {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const roots = [
      this.#configuredRoot,
      process.env.MCP_VSCODE_OPENVSCODE_ROOT,
      path.resolve(moduleDir, "../../runtime/openvscode-server"),
      path.resolve(moduleDir, "../runtime/openvscode-server"),
      path.resolve(process.cwd(), "runtime/openvscode-server"),
    ].filter((value): value is string => Boolean(value));
    const launch = await resolveOpenVscodeLaunch(roots);
    if (launch) return launch;
    throw new McpVscodeError(
      "Bundled OpenVSCode runtime not found. Run the runtime packaging script or set MCP_VSCODE_OPENVSCODE_ROOT.",
      "OPENVSCODE_RUNTIME_NOT_FOUND",
      { searchedRoots: roots },
    );
  }

  async #installBridgeExtension(extensionsDir: string): Promise<void> {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDir, "bridge-extension"),
      path.resolve(moduleDir, "../bridge-extension"),
      path.resolve(moduleDir, "../../dist/bridge-extension"),
      path.resolve(process.cwd(), "dist/bridge-extension"),
    ];
    let source: string | undefined;
    for (const candidate of candidates) {
      try {
        await access(path.join(candidate, "package.json"));
        source = candidate;
        break;
      } catch {
        // Try the next build layout.
      }
    }
    if (!source) {
      throw new McpVscodeError("Built VS Code bridge extension not found", "BRIDGE_EXTENSION_NOT_FOUND");
    }
    const workspaceHash = createHash("sha256").update(this.#workspaceRoot).digest("hex").slice(0, 8);
    const destination = path.join(extensionsDir, `flujo.mcp-vscode-0.1.0-${workspaceHash}`);
    await cp(source, destination, { recursive: true, force: true });
  }

  #log(value: string): void {
    for (const line of value.split(/\r?\n/).filter(Boolean)) {
      this.#logs.push(line);
      if (this.#logs.length > 200) this.#logs.shift();
      process.stderr.write(`[openvscode] ${line}\n`);
    }
  }
}

export async function resolveOpenVscodeLaunch(
  roots: string[],
  platform = process.platform,
): Promise<OpenVscodeLaunch | undefined> {
  for (const root of roots) {
    if (platform === "win32") {
      const node = path.join(root, "node.exe");
      const serverMain = path.join(root, "out", "server-main.js");
      if (await filesExist(node, serverMain)) {
        return { executable: node, prefixArgs: [serverMain], shell: false };
      }
      for (const relative of ["bin/openvscode-server.cmd", "bin/openvscode-server.bat", "bin/openvscode-server"]) {
        const executable = path.join(root, ...relative.split("/"));
        if (await filesExist(executable)) {
          return { executable, prefixArgs: [], shell: /\.(cmd|bat)$/i.test(executable) };
        }
      }
      continue;
    }

    const executable = path.join(root, "bin", "openvscode-server");
    if (await filesExist(executable)) return { executable, prefixArgs: [], shell: false };
  }
  return undefined;
}

async function filesExist(...files: string[]): Promise<boolean> {
  try {
    await Promise.all(files.map((file) => access(file)));
    return true;
  } catch {
    return false;
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Startup races are expected.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`OpenVSCode did not become ready within ${timeoutMs}ms`);
}
