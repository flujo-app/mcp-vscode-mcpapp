import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { VscodeCore } from "../core/core.js";
import { McpVscodeError, serializeError } from "../core/errors.js";
import { runProcess } from "../core/process.js";
import type { OpenVscodeRuntime } from "../runtime/openvscode.js";
import {
  WORKBENCH_IDE_META_KEY,
  WORKBENCH_STREAM_META_KEY,
  type WorkbenchIdeResultMeta,
  type WorkbenchStreamResultMeta,
  type WorkbenchStreamStatus,
} from "../stream/protocol.js";
import {
  terminalCreateShape,
  terminalKillShape,
  terminalReadShape,
  terminalResizeShape,
  terminalWriteShape,
  workspaceDeleteShape,
  workspaceListShape,
  workspaceMoveShape,
  workspaceReadShape,
  workspaceSearchShape,
  workspaceWriteShape,
} from "./schemas.js";

export const MCP_VSCODE_APP_RESOURCE_URI = "ui://mcp-vscode/workbench.html";

export interface McpServerContext {
  core: VscodeCore;
  runtime: OpenVscodeRuntime;
  gatewayOrigin: string;
  appHtmlPath: string;
  stream?: { status(gatewayOrigin?: string): WorkbenchStreamStatus };
}

export function createMcpServer(context: McpServerContext): McpServer {
  const { core, runtime } = context;
  const server = new McpServer({ name: "mcp-vscode", version: "0.2.2" }); // x-release-please-version

  /** Editor and diagnostics tools always target the genuine OpenVSCode bridge. */
  const callEditor = async (method: string, params?: unknown, timeoutMs?: number): Promise<Record<string, unknown>> => {
    const result = await core.bridge.call<unknown>(method, params, timeoutMs);
    const base = result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { value: result };
    return { ...base, surface: "vscode" };
  };

  registerAppTool(
    server,
    "vscode_open",
    {
      title: "Open VS Code",
      description: "Open the live, human-interactive VS Code workbench embedded in the MCP App.",
      inputSchema: {},
      _meta: {
        ui: {
          resourceUri: MCP_VSCODE_APP_RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => success(sessionPayload(context), appResultMeta(context)),
  );

  registerAppResource(
    server,
    "VS Code Workbench",
    MCP_VSCODE_APP_RESOURCE_URI,
    {
      description: "Self-hosted Code OSS workbench with live MCP synchronization.",
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {
            frameDomains: [context.gatewayOrigin],
            connectDomains: [context.gatewayOrigin, websocketOrigin(context.gatewayOrigin)],
          },
          permissions: { clipboardWrite: {} },
        },
      },
    },
    async () => {
      const html = await readFile(context.appHtmlPath, "utf8");
      return {
        contents: [
          {
            uri: MCP_VSCODE_APP_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                prefersBorder: false,
                csp: {
                  frameDomains: [context.gatewayOrigin],
                  connectDomains: [context.gatewayOrigin, websocketOrigin(context.gatewayOrigin)],
                },
                permissions: { clipboardWrite: {} },
              },
            },
          },
        ],
      };
    },
  );

  registerTool(server, "workspace_status", {
    title: "Workspace status",
    description: "Return the workspace, OpenVSCode, bridge, and terminal state.",
    inputSchema: {},
    annotations: readOnly,
    handler: async () => sessionPayload(context),
    resultMeta: () => appResultMeta(context),
  });

  registerTool(server, "fs_list", {
    title: "List files",
    description: "List files and directories inside the configured workspace.",
    inputSchema: workspaceListShape,
    annotations: readOnly,
    handler: async ({ path: userPath, recursive, maxEntries }) => ({
      entries: await core.workspace.list(userPath, recursive, maxEntries),
    }),
  });

  registerTool(server, "fs_read", {
    title: "Read file",
    description: "Read a UTF-8 or base64 file with a version hash for conflict-safe writes.",
    inputSchema: workspaceReadShape,
    annotations: readOnly,
    handler: async ({ path: userPath, encoding }) => await core.workspace.read(userPath, encoding),
  });

  registerTool(server, "fs_write", {
    title: "Write file",
    description: "Create or replace a workspace file. Use expectedVersion to prevent lost updates.",
    inputSchema: workspaceWriteShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (args) => {
      if (args.expectedVersion) {
        const current = await core.workspace.read(args.path, args.encoding);
        if (current.version !== args.expectedVersion) {
          throw new McpVscodeError("File changed since it was read", "VERSION_CONFLICT", {
            expected: args.expectedVersion,
            actual: current.version,
          });
        }
      }
      if (args.encoding === "utf8" && core.bridge.status().connected) {
        await core.bridge.call("workspace.writeFile", args);
        return await core.workspace.read(args.path, "utf8");
      }
      return await core.workspace.write(args);
    },
  });

  registerTool(server, "fs_delete", {
    title: "Delete file",
    description: "Delete a workspace file or, with recursive=true, a directory. The workspace root is protected.",
    inputSchema: workspaceDeleteShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async ({ path: userPath, recursive }) => await core.workspace.delete(userPath, recursive),
  });

  registerTool(server, "fs_move", {
    title: "Move file",
    description: "Move or rename a file or directory inside the workspace.",
    inputSchema: workspaceMoveShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async ({ from, to }) => await core.workspace.move(from, to),
  });

  registerTool(server, "fs_search", {
    title: "Search workspace",
    description: "Search text files recursively inside the workspace.",
    inputSchema: workspaceSearchShape,
    annotations: readOnly,
    handler: async (args) => ({ matches: await core.workspace.search(args) }),
  });

  registerTool(server, "editor_open", {
    title: "Open editor",
    description: "Open a workspace file in the visible VS Code editor and optionally reveal a range.",
    inputSchema: {
      path: z.string().min(1),
      line: z.number().int().min(1).optional(),
      column: z.number().int().min(1).optional(),
      preview: z.boolean().default(false),
      preserveFocus: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args) => await callEditor("editor.open", args),
  });

  registerTool(server, "editor_state", {
    title: "Get editor state",
    description: "Return visible editors, active document, selections, dirty buffers, and workspace folders.",
    inputSchema: {},
    annotations: readOnly,
    handler: async () => await callEditor("editor.state"),
  });

  registerTool(server, "editor_set_selection", {
    title: "Set editor selection",
    description: "Select and reveal a range in the visible editor.",
    inputSchema: {
      path: z.string().min(1),
      startLine: z.number().int().min(1),
      startColumn: z.number().int().min(1),
      endLine: z.number().int().min(1),
      endColumn: z.number().int().min(1),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args) => await callEditor("editor.setSelection", args),
  });

  registerTool(server, "editor_apply_edits", {
    title: "Apply visible edits",
    description: "Apply one or more text edits through VS Code so dirty state, undo, and the human UI stay synchronized.",
    inputSchema: {
      path: z.string().min(1),
      edits: z.array(z.object({
        startLine: z.number().int().min(1),
        startColumn: z.number().int().min(1),
        endLine: z.number().int().min(1),
        endColumn: z.number().int().min(1),
        text: z.string(),
      })).min(1),
      save: z.boolean().default(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async (args) => await callEditor("editor.applyEdits", args),
  });

  registerTool(server, "diagnostics_get", {
    title: "Get diagnostics",
    description: "Return VS Code diagnostics for a file or the entire workspace.",
    inputSchema: { path: z.string().optional() },
    annotations: readOnly,
    handler: async (args) => await callEditor("diagnostics.get", args),
  });

  registerTool(server, "vscode_list_commands", {
    title: "List VS Code commands",
    description: "List commands registered in the live OpenVSCode workbench.",
    inputSchema: { includeInternal: z.boolean().default(false) },
    annotations: readOnly,
    handler: async (args) => await core.bridge.call("commands.list", args),
  });

  registerTool(server, "vscode_execute_command", {
    title: "Execute VS Code command",
    description: "Execute any registered VS Code command. This is the escape hatch for the complete extension command surface.",
    inputSchema: {
      command: z.string().min(1),
      arguments: z.array(z.unknown()).default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args) => await core.bridge.call("commands.execute", args, 60_000),
  });

  registerTool(server, "extensions_list", {
    title: "List extensions",
    description: "List installed and active VS Code extensions.",
    inputSchema: {},
    annotations: readOnly,
    handler: async () => await core.bridge.call("extensions.list"),
  });

  registerTool(server, "extensions_install", {
    title: "Install extension",
    description: "Install an extension by identifier or VSIX URI through the VS Code command surface.",
    inputSchema: { extension: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async ({ extension }) => await core.bridge.call("extensions.install", { extension }, 120_000),
  });

  registerTool(server, "extensions_uninstall", {
    title: "Uninstall extension",
    description: "Uninstall a VS Code extension by identifier.",
    inputSchema: { extension: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async ({ extension }) => await core.bridge.call("extensions.uninstall", { extension }, 120_000),
  });

  registerTool(server, "terminal_create", {
    title: "Create terminal",
    description: "Create a terminal session shared by MCP tools and the embedded VS Code UI.",
    inputSchema: terminalCreateShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async ({ cwd, ...args }) => {
      const absoluteCwd = await core.workspace.resolve(cwd);
      return await core.terminals.create({ cwd: absoluteCwd, ...args });
    },
  });

  registerTool(server, "terminal_list", {
    title: "List terminals",
    description: "List shared terminal sessions.",
    inputSchema: {},
    annotations: readOnly,
    handler: async () => ({ terminals: core.terminals.list() }),
  });

  registerTool(server, "terminal_read", {
    title: "Read terminal",
    description: "Read recent buffered output from a terminal session.",
    inputSchema: terminalReadShape,
    annotations: readOnly,
    handler: async ({ id, tailCharacters }) => core.terminals.read(id, tailCharacters),
  });

  registerTool(server, "terminal_write", {
    title: "Write terminal input",
    description: "Write raw input to a shared terminal session.",
    inputSchema: terminalWriteShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async ({ id, data }) => core.terminals.write(id, data),
  });

  registerTool(server, "terminal_resize", {
    title: "Resize terminal",
    description: "Resize a shared terminal PTY.",
    inputSchema: terminalResizeShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async ({ id, columns, rows }) => core.terminals.resize(id, columns, rows),
  });

  registerTool(server, "terminal_kill", {
    title: "Kill terminal",
    description: "Terminate a shared terminal process.",
    inputSchema: terminalKillShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async ({ id }) => core.terminals.kill(id),
  });

  registerTool(server, "git_status", {
    title: "Git status",
    description: "Return machine-readable Git status for the workspace repository.",
    inputSchema: {},
    annotations: readOnly,
    handler: async () => processResult(await runProcess({
      command: "git",
      args: ["status", "--short", "--branch"],
      cwd: core.workspace.root,
    })),
  });

  registerTool(server, "git_diff", {
    title: "Git diff",
    description: "Return a Git diff, optionally staged or scoped to a path.",
    inputSchema: {
      staged: z.boolean().default(false),
      path: z.string().optional(),
    },
    annotations: readOnly,
    handler: async ({ staged, path: userPath }) => {
      const args = ["diff", "--no-ext-diff", ...(staged ? ["--cached"] : [])];
      if (userPath) args.push("--", userPath);
      return processResult(await runProcess({ command: "git", args, cwd: core.workspace.root }));
    },
  });

  registerTool(server, "git_run", {
    title: "Run Git command",
    description: "Run a Git subcommand inside the workspace. Hooks are disabled for this invocation.",
    inputSchema: {
      arguments: z.array(z.string()).min(1),
      timeoutMs: z.number().int().min(1).max(300_000).default(60_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async ({ arguments: gitArgs, timeoutMs }) => processResult(await runProcess({
      command: "git",
      args: ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...gitArgs],
      cwd: core.workspace.root,
      timeoutMs,
    })),
  });

  return server;
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: Shape;
    annotations: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>;
    resultMeta?: () => Record<string, unknown> | undefined;
  },
): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  register(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: config.annotations,
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async (args: unknown): Promise<CallToolResult> => {
      try {
        return success(
          await config.handler(args as z.infer<z.ZodObject<Shape>>),
          config.resultMeta?.(),
        );
      } catch (error) {
        const serialized = serializeError(error);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(serialized, null, 2) }],
          structuredContent: { error: serialized },
        };
      }
    },
  );
}

function success(value: unknown, meta?: Record<string, unknown>): CallToolResult {
  const structuredContent = asObject(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
    ...(meta ? { _meta: meta } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function sessionPayload(context: McpServerContext): Record<string, unknown> {
  const streamStatus = context.stream?.status(context.gatewayOrigin);
  const publicStreamStatus = streamStatus
    ? (({ websocketUrl: _secret, ...status }) => status)(streamStatus)
    : undefined;
  return {
    ...context.core.status(),
    openVscode: publicRuntimeStatus(context.runtime.status()),
    gatewayOrigin: context.gatewayOrigin,
    ...(publicStreamStatus ? { stream: publicStreamStatus } : {}),
  };
}

function appResultMeta(context: McpServerContext): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  const ideUrl = context.runtime.status().browserUrl;
  if (ideUrl) {
    const value: WorkbenchIdeResultMeta = { ideUrl };
    meta[WORKBENCH_IDE_META_KEY] = value;
  }
  const websocketUrl = context.stream?.status(context.gatewayOrigin).websocketUrl;
  if (websocketUrl) {
    const value: WorkbenchStreamResultMeta = { websocketUrl };
    meta[WORKBENCH_STREAM_META_KEY] = value;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function publicRuntimeStatus(status: ReturnType<OpenVscodeRuntime["status"]>): Record<string, unknown> {
  return {
    state: status.state,
    ...(status.error ? { error: status.error } : {}),
  };
}

function processResult(result: Awaited<ReturnType<typeof runProcess>>): Record<string, unknown> {
  return {
    ...result,
    ok: result.exitCode === 0 && !result.timedOut,
  };
}

function websocketOrigin(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

export function defaultAppHtmlPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "app.html");
}
