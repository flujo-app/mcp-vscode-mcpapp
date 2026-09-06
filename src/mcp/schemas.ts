import { z } from "zod";

// Shared ZodRawShape definitions for the MCP tool surface.

export const workspaceListShape = {
  path: z.string().default("."),
  recursive: z.boolean().default(false),
  maxEntries: z.number().int().min(1).max(20_000).default(2_000),
};

export const workspaceReadShape = {
  path: z.string().min(1),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
};

export const workspaceWriteShape = {
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  expectedVersion: z.string().optional(),
  createParents: z.boolean().default(true),
};

export const workspaceDeleteShape = {
  path: z.string().min(1),
  recursive: z.boolean().default(false),
};

export const workspaceMoveShape = {
  from: z.string().min(1),
  to: z.string().min(1),
};

export const workspaceSearchShape = {
  query: z.string().min(1).max(4000),
  path: z.string().default("."),
  regex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(2_000).default(200),
};

export const terminalRunShape = {
  command: z
    .string()
    .min(1)
    .max(32768)
    .describe(
      "Executable path or name. Pass arguments separately; shell syntax requires explicitly running a shell.",
    ),
  args: z.array(z.string().max(32768)).max(512).default([]),
  cwd: z.string().default("."),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  maxOutputBytes: z.number().int().min(1).max(8_000_000).default(2_000_000),
};

export const terminalCreateShape = {
  cwd: z.string().default("."),
  shell: z.string().optional(),
  args: z.array(z.string()).optional(),
  name: z.string().optional(),
  waitForOutputMs: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(1000)
    .describe(
      "Wait for first output; a banner is not proof that an interactive prompt is ready.",
    ),
  columns: z.number().int().min(10).max(500).default(120),
  rows: z.number().int().min(2).max(200).default(30),
  env: z.record(z.string(), z.string()).optional(),
};

export const terminalReadShape = {
  stripAnsi: z.boolean().default(true),
  id: z.string().uuid(),
  tailCharacters: z.number().int().min(1).max(2_000_000).default(20_000),
};

export const terminalWriteShape = {
  submit: z
    .boolean()
    .default(false)
    .describe(
      "Append Enter for this backend. Without submit, data is written raw.",
    ),
  id: z.string().uuid(),
  data: z.string(),
};

export const terminalResizeShape = {
  id: z.string().uuid(),
  columns: z.number().int().min(10).max(500),
  rows: z.number().int().min(2).max(200),
};

export const terminalKillShape = {
  id: z.string().uuid(),
};
