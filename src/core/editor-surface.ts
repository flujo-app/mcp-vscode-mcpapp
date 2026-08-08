import { McpVscodeError } from "./errors.js";

export type EditorSurfaceKind = "vscode" | "native";

export interface EditorSurface {
  readonly kind: EditorSurfaceKind;
  available(): boolean;
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/**
 * Narrow, structural view of `VscodeBridge` (`../core/bridge.js`). Typing the
 * router against this interface instead of the concrete class keeps
 * `EditorSurfaceRouter` unit-testable with a plain fake (a real `VscodeBridge`
 * satisfies it too, so production wiring in `core.ts` is unaffected).
 */
export interface BridgeLike {
  status(): { connected: boolean };
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/**
 * Resolves which live editor surface ("vscode" bridge or "native" `/ui`
 * renderer) the five `editor_*`/`diagnostics_get` MCP tools should be routed
 * to. See Phase 3 plan (issue #8) §2.1.
 */
export class EditorSurfaceRouter {
  #native?: EditorSurface;
  readonly #bridge: BridgeLike;
  readonly #vscodeSurface: EditorSurface;

  constructor(bridge: BridgeLike) {
    this.#bridge = bridge;
    this.#vscodeSurface = {
      kind: "vscode",
      available: () => this.#bridge.status().connected,
      call: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) =>
        this.#bridge.call<T>(method, params, timeoutMs),
    };
  }

  /** Registered once by the gateway (HTTP layer); `core.ts` must not depend on it directly. */
  registerNative(surface: EditorSurface): void {
    this.#native = surface;
  }

  unregisterNative(surface: EditorSurface): void {
    if (this.#native === surface) this.#native = undefined;
  }

  /**
   * Resolution order: connected VS Code bridge (full fidelity) wins, then an
   * attached native `/ui` renderer, else throws `NO_EDITOR_SURFACE`. Never
   * waits on I/O, so callers fail fast.
   */
  resolve(): EditorSurface {
    if (this.#bridge.status().connected) return this.#vscodeSurface;
    if (this.#native?.available()) return this.#native;
    throw new McpVscodeError(
      "No editor surface is connected. Open the VS Code app view (vscode_open) or connect the bridge extension, then retry.",
      "NO_EDITOR_SURFACE",
      { bridge: false, native: false },
    );
  }

  status(): { surface: EditorSurfaceKind | "none"; bridge: boolean; native: boolean } {
    const bridge = this.#bridge.status().connected;
    const native = this.#native?.available() ?? false;
    return {
      surface: bridge ? "vscode" : native ? "native" : "none",
      bridge,
      native,
    };
  }
}
