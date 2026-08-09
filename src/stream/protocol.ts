/**
 * Experimental workbench pixel-streaming protocol.
 *
 * The browser-facing side is intentionally a very small remote-display
 * protocol. It cannot navigate the server-side browser or issue arbitrary
 * CDP commands; it can only resize the viewport and provide user input.
 */
export const WORKBENCH_STREAM_PROTOCOL_VERSION = 1;
export const WORKBENCH_STREAM_META_KEY = "io.github.mario-andreschak/mcp-vscode-stream";
export const WORKBENCH_IDE_META_KEY = "io.github.mario-andreschak/mcp-vscode-ide";

export interface WorkbenchIdeResultMeta {
  ideUrl: string;
}

export interface WorkbenchStreamResultMeta {
  websocketUrl: string;
}

export type WorkbenchStreamState =
  | "disabled"
  | "idle"
  | "starting"
  | "ready"
  | "unavailable"
  | "failed"
  | "stopped";

export interface WorkbenchStreamStatus {
  enabled: boolean;
  experimental: true;
  state: WorkbenchStreamState;
  websocketUrl?: string;
  browser?: string;
  error?: string;
}

export type StreamMouseButton = "none" | "left" | "middle" | "right" | "back" | "forward";

export type WorkbenchStreamClientMessage =
  | {
      type: "resize";
      width: number;
      height: number;
    }
  | {
      type: "pointer";
      event: "move" | "down" | "up";
      x: number;
      y: number;
      button: StreamMouseButton;
      buttons: number;
      clickCount: number;
      altKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      altKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
    }
  | {
      type: "key";
      event: "down" | "up";
      key: string;
      code: string;
      keyCode: number;
      location: number;
      repeat: boolean;
      altKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
    }
  | {
      type: "text";
      text: string;
    };

export type WorkbenchStreamServerMessage =
  | {
      type: "hello";
      protocol: typeof WORKBENCH_STREAM_PROTOCOL_VERSION;
      width: number;
      height: number;
    }
  | {
      type: "status";
      state: Exclude<WorkbenchStreamState, "disabled">;
      message?: string;
    }
  | {
      type: "frame";
      sequence: number;
      format: "jpeg";
      data: string;
      width: number;
      height: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export const STREAM_VIEWPORT_LIMITS = {
  minWidth: 320,
  minHeight: 240,
  maxWidth: 3_840,
  maxHeight: 2_160,
} as const;

export const STREAM_TEXT_LIMIT = 1_000_000;
