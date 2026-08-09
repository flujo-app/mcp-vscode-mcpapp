import {
  STREAM_VIEWPORT_LIMITS,
  WORKBENCH_STREAM_PROTOCOL_VERSION,
  type StreamMouseButton,
  type WorkbenchStreamClientMessage,
  type WorkbenchStreamServerMessage,
} from "../stream/protocol.js";

export type StreamedWorkbenchStatus = "connecting" | "starting" | "ready" | "closed" | "error";

export interface StreamedWorkbenchOptions {
  onStatus?: (status: StreamedWorkbenchStatus, message?: string) => void;
}

/**
 * Canvas client for the experimental genuine-workbench pixel stream. This
 * class contains no editor implementation: every pixel comes from the real
 * OpenVSCode workbench running in server-side Chromium.
 */
export class StreamedWorkbench {
  readonly #container: HTMLElement;
  readonly #url: string;
  readonly #options: StreamedWorkbenchOptions;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  #socket?: WebSocket;
  #resizeObserver?: ResizeObserver;
  #disposed = false;
  #ready = false;
  #mountPromise?: Promise<void>;
  #resolveMount?: () => void;
  #rejectMount?: (error: Error) => void;
  #mountTimer?: number;
  #frameWidth = 1;
  #frameHeight = 1;
  #pendingFrame?: Extract<WorkbenchStreamServerMessage, { type: "frame" }>;
  #decodingFrame = false;
  #pointerAnimationFrame?: number;
  #pendingPointer?: PointerEvent;

  constructor(container: HTMLElement, websocketUrl: string, options: StreamedWorkbenchOptions = {}) {
    this.#container = container;
    this.#url = websocketUrl;
    this.#options = options;
    this.#canvas = document.createElement("canvas");
    this.#canvas.className = "streamed-workbench";
    this.#canvas.tabIndex = 0;
    this.#canvas.setAttribute("role", "application");
    this.#canvas.setAttribute("aria-label", "Streamed VS Code workbench");
    Object.assign(this.#canvas.style, {
      display: "block",
      width: "100%",
      height: "100%",
      outline: "none",
      background: "#1e1e1e",
      touchAction: "none",
      cursor: "default",
    });
    const context = this.#canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D rendering is unavailable");
    this.#context = context;
  }

  mount(timeoutMs = 30_000): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Streamed workbench is disposed"));
    if (this.#mountPromise) return this.#mountPromise;
    this.#container.replaceChildren(this.#canvas);
    this.#bindInput();
    this.#resizeObserver = new ResizeObserver(() => this.#sendResize());
    this.#resizeObserver.observe(this.#container);
    this.#options.onStatus?.("connecting");

    this.#mountPromise = new Promise<void>((resolve, reject) => {
      this.#resolveMount = resolve;
      this.#rejectMount = reject;
      this.#mountTimer = window.setTimeout(() => {
        this.#failMount(new Error("The streamed workbench did not become ready in time"));
      }, timeoutMs);
    });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch (error) {
      this.#failMount(asError(error));
      return this.#mountPromise;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => this.#sendResize());
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("error", () => {
      if (!this.#ready) this.#failMount(new Error("The workbench stream connection failed"));
      else this.#options.onStatus?.("error", "The workbench stream connection failed");
    });
    socket.addEventListener("close", (event) => {
      if (this.#disposed) return;
      const detail = event.reason || `connection closed (${event.code})`;
      if (!this.#ready) this.#failMount(new Error(`The workbench stream ${detail}`));
      else this.#options.onStatus?.("closed", detail);
    });
    return this.#mountPromise;
  }

  focus(): void {
    this.#canvas.focus();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#mountTimer !== undefined) window.clearTimeout(this.#mountTimer);
    if (this.#pointerAnimationFrame !== undefined) window.cancelAnimationFrame(this.#pointerAnimationFrame);
    this.#resizeObserver?.disconnect();
    this.#socket?.close(1000, "renderer disposed");
    this.#socket = undefined;
    this.#canvas.remove();
    if (!this.#ready) this.#rejectMount?.(new Error("Streamed workbench was disposed before it became ready"));
  }

  #onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: WorkbenchStreamServerMessage;
    try {
      message = JSON.parse(raw) as WorkbenchStreamServerMessage;
    } catch {
      return;
    }
    if (message.type === "hello") {
      if (message.protocol !== WORKBENCH_STREAM_PROTOCOL_VERSION) {
        this.#failMount(new Error(`Unsupported workbench stream protocol ${String(message.protocol)}`));
        return;
      }
      this.#frameWidth = message.width;
      this.#frameHeight = message.height;
      return;
    }
    if (message.type === "status") {
      if (message.state === "starting" || message.state === "idle") {
        this.#options.onStatus?.("starting", message.message);
      } else if (message.state === "ready") {
        // Resolve mount only after a real decoded frame is painted. A CDP
        // session being ready by itself must never reveal a blank canvas.
        this.#options.onStatus?.("starting", "Waiting for the first workbench frame");
      } else if (message.state === "failed" || message.state === "unavailable" || message.state === "stopped") {
        this.#failMount(new Error(message.message ?? `Workbench stream is ${message.state}`));
      }
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.message);
      if (!this.#ready) this.#failMount(error);
      else this.#options.onStatus?.("error", message.message);
      return;
    }
    if (message.type === "frame") {
      this.#frameWidth = message.width;
      this.#frameHeight = message.height;
      this.#pendingFrame = message;
      void this.#drawLatestFrame();
    }
  }

  async #drawLatestFrame(): Promise<void> {
    if (this.#decodingFrame) return;
    this.#decodingFrame = true;
    try {
      while (this.#pendingFrame && !this.#disposed) {
        const frame = this.#pendingFrame;
        this.#pendingFrame = undefined;
        const bytes = decodeBase64(frame.data);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        try {
          if (this.#canvas.width !== bitmap.width) this.#canvas.width = bitmap.width;
          if (this.#canvas.height !== bitmap.height) this.#canvas.height = bitmap.height;
          this.#frameWidth = bitmap.width;
          this.#frameHeight = bitmap.height;
          this.#context.drawImage(bitmap, 0, 0);
          this.#markReady();
        } finally {
          bitmap.close();
        }
      }
    } catch (error) {
      const failure = new Error(`Unable to decode a workbench frame: ${asError(error).message}`);
      if (this.#ready) this.#options.onStatus?.("error", failure.message);
      else this.#failMount(failure);
    } finally {
      this.#decodingFrame = false;
      if (this.#pendingFrame) void this.#drawLatestFrame();
    }
  }

  #markReady(): void {
    if (this.#ready) return;
    this.#ready = true;
    if (this.#mountTimer !== undefined) window.clearTimeout(this.#mountTimer);
    this.#options.onStatus?.("ready");
    this.#resolveMount?.();
    this.#canvas.focus();
  }

  #failMount(error: Error): void {
    if (this.#ready) {
      this.#options.onStatus?.("error", error.message);
      return;
    }
    if (this.#mountTimer !== undefined) window.clearTimeout(this.#mountTimer);
    this.#options.onStatus?.("error", error.message);
    this.#rejectMount?.(error);
    this.#socket?.close();
  }

  #sendResize(): void {
    const rect = this.#container.getBoundingClientRect();
    this.#send({
      type: "resize",
      width: clamp(Math.round(rect.width), STREAM_VIEWPORT_LIMITS.minWidth, STREAM_VIEWPORT_LIMITS.maxWidth),
      height: clamp(Math.round(rect.height), STREAM_VIEWPORT_LIMITS.minHeight, STREAM_VIEWPORT_LIMITS.maxHeight),
    });
  }

  #bindInput(): void {
    this.#canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.#canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.#canvas.focus();
      this.#canvas.setPointerCapture(event.pointerId);
      this.#sendPointer("down", event);
    });
    this.#canvas.addEventListener("pointerup", (event) => {
      event.preventDefault();
      if (this.#canvas.hasPointerCapture(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
      this.#sendPointer("up", event);
    });
    this.#canvas.addEventListener("pointercancel", (event) => {
      if (this.#canvas.hasPointerCapture(event.pointerId)) this.#canvas.releasePointerCapture(event.pointerId);
      this.#sendPointer("up", event);
    });
    this.#canvas.addEventListener("pointermove", (event) => {
      this.#pendingPointer = event;
      if (this.#pointerAnimationFrame !== undefined) return;
      this.#pointerAnimationFrame = window.requestAnimationFrame(() => {
        this.#pointerAnimationFrame = undefined;
        const latest = this.#pendingPointer;
        this.#pendingPointer = undefined;
        if (latest) this.#sendPointer("move", latest);
      });
    });
    this.#canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const point = this.#streamPoint(event.clientX, event.clientY);
      this.#send({
        type: "wheel",
        ...point,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        ...modifiers(event),
      });
    }, { passive: false });
    this.#canvas.addEventListener("keydown", (event) => {
      event.preventDefault();
      this.#sendKey("down", event);
    });
    this.#canvas.addEventListener("keyup", (event) => {
      event.preventDefault();
      this.#sendKey("up", event);
    });
    this.#canvas.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      event.preventDefault();
      this.#send({ type: "text", text });
    });
  }

  #sendPointer(event: "move" | "down" | "up", source: PointerEvent): void {
    const point = this.#streamPoint(source.clientX, source.clientY);
    this.#send({
      type: "pointer",
      event,
      ...point,
      button: mouseButton(source.button),
      buttons: source.buttons,
      clickCount: source.detail || 1,
      ...modifiers(source),
    });
  }

  #sendKey(event: "down" | "up", source: KeyboardEvent): void {
    this.#send({
      type: "key",
      event,
      key: source.key,
      code: source.code,
      keyCode: source.keyCode,
      location: source.location,
      repeat: source.repeat,
      ...modifiers(source),
    });
  }

  #streamPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    return {
      x: rect.width > 0 ? ((clientX - rect.left) / rect.width) * this.#frameWidth : 0,
      y: rect.height > 0 ? ((clientY - rect.top) / rect.height) * this.#frameHeight : 0,
    };
  }

  #send(message: WorkbenchStreamClientMessage): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(message));
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function modifiers(event: MouseEvent | KeyboardEvent) {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

function mouseButton(button: number): StreamMouseButton {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return "none";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
