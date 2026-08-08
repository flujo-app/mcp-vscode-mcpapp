import { z } from "zod";

// Single source of truth for the argument shapes used by both the MCP tool
// surface (`src/mcp/server.ts`) and the `/ui` WebSocket dispatch
// (`src/http/ui-socket.ts`). Each `*Shape` is a plain `ZodRawShape` suitable
// for `server.registerTool({ inputSchema: ...Shape })`; each `*Schema` is the
// corresponding `z.object(...)` used to validate `/ui` RPC params.

export const workspaceListShape = {
  path: z.string().default("."),
  recursive: z.boolean().default(false),
  maxEntries: z.number().int().min(1).max(20_000).default(2_000),
};
export const workspaceListSchema = z.object(workspaceListShape);

export const workspaceReadShape = {
  path: z.string().min(1),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
};
export const workspaceReadSchema = z.object(workspaceReadShape);

export const workspaceWriteShape = {
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  expectedVersion: z.string().optional(),
  createParents: z.boolean().default(true),
};
export const workspaceWriteSchema = z.object(workspaceWriteShape);

export const workspaceDeleteShape = {
  path: z.string().min(1),
  recursive: z.boolean().default(false),
};
export const workspaceDeleteSchema = z.object(workspaceDeleteShape);

export const workspaceMoveShape = {
  from: z.string().min(1),
  to: z.string().min(1),
};
export const workspaceMoveSchema = z.object(workspaceMoveShape);

export const workspaceSearchShape = {
  query: z.string().min(1),
  path: z.string().default("."),
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(2_000).default(200),
};
export const workspaceSearchSchema = z.object(workspaceSearchShape);

export const terminalCreateShape = {
  cwd: z.string().default("."),
  shell: z.string().optional(),
  args: z.array(z.string()).optional(),
  name: z.string().optional(),
  columns: z.number().int().min(10).max(500).default(120),
  rows: z.number().int().min(2).max(200).default(30),
  env: z.record(z.string(), z.string()).optional(),
};
export const terminalCreateSchema = z.object(terminalCreateShape);

export const terminalReadShape = {
  id: z.string().uuid(),
  tailCharacters: z.number().int().min(1).max(2_000_000).default(20_000),
};
export const terminalReadSchema = z.object(terminalReadShape);

export const terminalWriteShape = {
  id: z.string().uuid(),
  data: z.string(),
};
export const terminalWriteSchema = z.object(terminalWriteShape);

export const terminalResizeShape = {
  id: z.string().uuid(),
  columns: z.number().int().min(10).max(500),
  rows: z.number().int().min(2).max(200),
};
export const terminalResizeSchema = z.object(terminalResizeShape);

export const terminalKillShape = {
  id: z.string().uuid(),
};
export const terminalKillSchema = z.object(terminalKillShape);

export const terminalAttachSchema = z.object({
  id: z.string().uuid(),
});
