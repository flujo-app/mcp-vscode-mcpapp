export class McpVscodeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "McpVscodeError";
  }
}

export function serializeError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof McpVscodeError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
