export type McpVscodeRenderMode = "default" | "stream";

/** Parse the deliberately small public render-mode switch. */
export function parseRenderMode(value: string | undefined): McpVscodeRenderMode {
  if (value === undefined || value === "" || value === "default") return "default";
  if (value === "stream") return "stream";
  throw new Error(
    `Invalid MCP_VSCODE_RENDER_MODE value ${JSON.stringify(value)}; expected "default" or "stream"`,
  );
}

export function parseBooleanEnv(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`Invalid ${name} value ${JSON.stringify(value)}; expected 0, 1, false, or true`);
}
