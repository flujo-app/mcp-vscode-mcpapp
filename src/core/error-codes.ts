/**
 * Documented union of every `McpVscodeError.code` value in use across the
 * server. `McpVscodeError.code` itself stays `string` (see `errors.ts`) to
 * avoid touching call sites outside this PR's scope; this file exists so new
 * code (and tests) can reference known codes without retyping string
 * literals, and so a typo in a new code is easy to spot in review.
 */
export type ErrorCode =
  | "INTERNAL_ERROR"
  | "VSCODE_BRIDGE_UNAVAILABLE"
  | "VSCODE_RPC_TIMEOUT"
  | "VSCODE_RPC_ERROR"
  | "INVALID_PATH"
  | "NOT_A_DIRECTORY"
  | "VERSION_CONFLICT"
  | "ROOT_DELETE_FORBIDDEN"
  | "RECURSIVE_REQUIRED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "METHOD_NOT_FOUND"
  | "TERMINAL_NOT_FOUND"
  | "TERMINAL_EXITED"
  | "BRIDGE_EXTENSION_NOT_FOUND"
  // Phase 3 (issue #8): renderer-aware editor tool routing.
  | "NO_EDITOR_SURFACE"
  | "UI_RPC_TIMEOUT"
  | "UI_RPC_ERROR";

export const ERROR_CODES: readonly ErrorCode[] = [
  "INTERNAL_ERROR",
  "VSCODE_BRIDGE_UNAVAILABLE",
  "VSCODE_RPC_TIMEOUT",
  "VSCODE_RPC_ERROR",
  "INVALID_PATH",
  "NOT_A_DIRECTORY",
  "VERSION_CONFLICT",
  "ROOT_DELETE_FORBIDDEN",
  "RECURSIVE_REQUIRED",
  "PATH_OUTSIDE_WORKSPACE",
  "METHOD_NOT_FOUND",
  "TERMINAL_NOT_FOUND",
  "TERMINAL_EXITED",
  "BRIDGE_EXTENSION_NOT_FOUND",
  "NO_EDITOR_SURFACE",
  "UI_RPC_TIMEOUT",
  "UI_RPC_ERROR",
];
