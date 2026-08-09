import { parseArgs } from "node:util";
import path from "node:path";
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VscodeCore } from "./core/core.js";
import { Gateway } from "./http/gateway.js";
import { runtimeBrokerRegistrationFromEnv } from "./http/runtime-registration.js";
import {
  createMcpServer,
  defaultAppHtmlPath,
  MCP_VSCODE_APP_RESOURCE_URI,
} from "./mcp/server.js";
import { OpenVscodeRuntime } from "./runtime/openvscode.js";
import { parseBooleanEnv, parseRenderMode } from "./runtime/render-mode.js";

const parsed = parseArgs({
  allowPositionals: false,
  strict: true,
  options: {
    stdio: { type: "boolean", default: false },
    http: { type: "boolean", default: false },
    https: { type: "boolean", default: false },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
    workspace: { type: "string" },
    "public-url": { type: "string" },
    "auth-token": { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    "openvscode-root": { type: "string" },
    "ide-url": { type: "string" },
    "state-dir": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (parsed.values.help) {
  process.stdout.write(`mcp-vscode [options]\n\n` +
    `  --stdio                 Serve MCP over stdio (also starts the local UI gateway)\n` +
    `  --http                  Serve Streamable HTTP (default when --stdio is absent)\n` +
    `  --https                 Enable TLS; requires --cert and --key\n` +
    `  --host <address>        Gateway bind address (default 127.0.0.1)\n` +
    `  --port <number>         Gateway port, 0 chooses a free port\n` +
    `  --workspace <path>      Workspace root exposed to VS Code and MCP tools\n` +
    `                          (or set MCP_VSCODE_WORKSPACE)\n` +
    `  --public-url <url>      Browser-visible gateway origin for remote deployments\n` +
    `  --auth-token <token>    Bearer token required by the /mcp endpoint\n` +
    `  --cert/--key <path>     PEM TLS certificate and private key\n` +
    `  --openvscode-root <dir> Override the bundled OpenVSCode runtime location\n` +
    `  --ide-url <url>         Development-only external IDE target\n\n` +
    `Experimental environment options:\n` +
    `  MCP_VSCODE_RENDER_MODE=stream       Pixel-stream the genuine workbench\n` +
    `  MCP_VSCODE_STREAM_BROWSER=<path>    Override Edge/Chrome/Chromium discovery\n` +
    `  MCP_VSCODE_STREAM_NO_SANDBOX=1      Disable Chromium sandbox (unsafe)\n`);
  process.exit(0);
}

await main();

async function main(): Promise<void> {
  const values = parsed.values;
  // Precedence is unchanged (--workspace, then MCP_VSCODE_WORKSPACE, then cwd),
  // but an implicit cwd is now reported: server.json declares the workspace as
  // required, and silently inheriting the spawner's cwd is how the root ends up
  // pointing at an unrelated directory such as a mounted volume root.
  const configuredWorkspace = values.workspace ?? process.env.MCP_VSCODE_WORKSPACE;
  const workspaceRoot = path.resolve(configuredWorkspace ?? process.cwd());
  const host = values.host ?? "127.0.0.1";
  const renderMode = parseRenderMode(process.env.MCP_VSCODE_RENDER_MODE);
  const runtimeBroker = runtimeBrokerRegistrationFromEnv();
  const streamNoSandbox = parseBooleanEnv(
    "MCP_VSCODE_STREAM_NO_SANDBOX",
    process.env.MCP_VSCODE_STREAM_NO_SANDBOX,
  );
  const port = Number.parseInt(values.port ?? "0", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Invalid port: ${values.port}`);
  if (values.https && (!values.cert || !values.key)) {
    throw new Error("--https requires both --cert and --key");
  }
  if (!isLoopback(host) && !values["auth-token"]) {
    throw new Error("Binding beyond loopback requires --auth-token");
  }
  if (!isLoopback(host) && !values.https) {
    throw new Error("Binding beyond loopback requires --https");
  }

  if (!configuredWorkspace) {
    process.stderr.write(
      `[mcp-vscode] No workspace configured; using the current directory: ${workspaceRoot}\n`
      + `[mcp-vscode] Set MCP_VSCODE_WORKSPACE or pass --workspace to pin the workspace root\n`,
    );
  }

  const core = new VscodeCore(workspaceRoot);
  await core.initialize();
  const runtime = new OpenVscodeRuntime({
    core,
    workspaceRoot,
    ...(values["state-dir"] ? { stateRoot: path.resolve(values["state-dir"]) } : {}),
    ...(values["openvscode-root"] ? { openVscodeRoot: path.resolve(values["openvscode-root"]) } : {}),
    ...(values["ide-url"] ? { externalIdeUrl: values["ide-url"] } : {}),
  });
  const gateway = new Gateway({
    core,
    runtime,
    host,
    port,
    appHtmlPath: defaultAppHtmlPath(),
    ...(values["public-url"] ? { publicUrl: values["public-url"] } : {}),
    ...(values["auth-token"] ? { authToken: values["auth-token"] } : {}),
    stream: {
      enabled: renderMode === "stream",
      ...(process.env.MCP_VSCODE_STREAM_BROWSER
        ? { browserExecutable: process.env.MCP_VSCODE_STREAM_BROWSER }
        : {}),
      noSandbox: streamNoSandbox,
    },
    ...(runtimeBroker
      ? {
          runtimeBroker: {
            registration: runtimeBroker,
            resourceUri: MCP_VSCODE_APP_RESOURCE_URI,
          },
        }
      : {}),
    ...(values.https && values.cert && values.key
      ? { tls: { certPath: path.resolve(values.cert), keyPath: path.resolve(values.key) } }
      : {}),
  });
  const address = await gateway.start();
  const bridgeUrl = gateway.localBridgeUrl;
  const runtimeStatus = await runtime.start({ gatewayOrigin: address.origin, bridgeUrl });
  if (runtimeBroker) {
    process.stderr.write(`[mcp-vscode] FLUJO App runtime origin: ${address.origin}\n`);
  } else {
    process.stderr.write(`[mcp-vscode] UI gateway: ${address.origin}/app\n`);
    process.stderr.write(`[mcp-vscode] MCP endpoint: ${address.origin}/mcp\n`);
  }
  if (runtimeStatus.browserUrl) {
    process.stderr.write(`[mcp-vscode] OpenVSCode: ${redactWorkbenchCapability(runtimeStatus.browserUrl)}\n`);
  }
  else process.stderr.write(`[mcp-vscode] OpenVSCode unavailable: ${runtimeStatus.error ?? "unknown error"}\n`);
  if (renderMode === "stream") {
    process.stderr.write("[mcp-vscode] Experimental genuine-workbench pixel streaming enabled\n");
  }

  let stdioServer: ReturnType<typeof createMcpServer> | undefined;
  if (values.stdio) {
    stdioServer = createMcpServer(gateway.mcpContext());
    await stdioServer.connect(new StdioServerTransport());
  }

  const shutdown = async () => {
    await stdioServer?.close();
    await gateway.close();
    runtime.close();
    await core.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function redactWorkbenchCapability(value: string): string {
  try {
    return `${new URL(value).origin}/ide/<app-only>/`;
  } catch {
    return "ready (App-only URL)";
  }
}
