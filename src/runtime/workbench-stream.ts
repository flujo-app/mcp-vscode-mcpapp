import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chown, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { OpenVscodeRuntime } from "./openvscode.js";
import { discoverChromiumExecutable } from "./chromium-discovery.js";
import {
  isSafeSharedTempDirectory,
  selectChromiumIdentity,
  type ChromiumIdentityDecision,
} from "./chromium-identity.js";
import {
  STREAM_TEXT_LIMIT,
  STREAM_VIEWPORT_LIMITS,
  WORKBENCH_STREAM_PROTOCOL_VERSION,
  type StreamMouseButton,
  type WorkbenchStreamClientMessage,
  type WorkbenchStreamServerMessage,
  type WorkbenchStreamState,
  type WorkbenchStreamStatus,
} from "../stream/protocol.js";

const DEFAULT_WIDTH = 1_280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FRAME_RATE = 12;
const DEFAULT_JPEG_QUALITY = 65;
const CDP_TIMEOUT_MS = 15_000;

type RuntimeForStreaming = Pick<OpenVscodeRuntime, "target" | "basePath" | "status">;

export interface WorkbenchStreamControllerOptions {
  enabled: boolean;
  runtime: RuntimeForStreaming;
  browserExecutable?: string;
  noSandbox?: boolean;
  frameRate?: number;
  jpegQuality?: number;
  /** Test seam. Production uses the system-Chromium launcher below. */
  launchBrowser?: StreamBrowserLauncher;
}

export interface StreamBrowserSession {
  readonly browser: string;
  readonly sessionId: string;
  /** Test/diagnostic visibility; never sent to the MCP App. */
  readonly processId?: number;
  /** Ephemeral local path; never sent to the MCP App. */
  readonly profileDirectory?: string;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export type StreamBrowserLauncher = (options: {
  targetUrl: string;
  browserExecutable?: string;
  noSandbox: boolean;
  width: number;
  height: number;
}) => Promise<StreamBrowserSession>;

/**
 * Owns one loopback-only headless Chromium and one authenticated viewer.
 * It deliberately exposes neither CDP nor browser navigation to the viewer.
 */
export class WorkbenchStreamController {
  readonly #options: WorkbenchStreamControllerOptions;
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: STREAM_TEXT_LIMIT * 4 + 65_536 });
  readonly #token = randomBytes(32).toString("base64url");
  #state: WorkbenchStreamState;
  #browser?: StreamBrowserSession;
  #browserPromise?: Promise<StreamBrowserSession>;
  #viewer?: WebSocket;
  #error?: string;
  #viewport = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  #sequence = 0;
  #lastFrameAt = 0;
  #frameTimer?: NodeJS.Timeout;
  #pendingFrameAck?: { browser: StreamBrowserSession; sessionId: number };
  #screencastRunning = false;
  #resizeQueue = Promise.resolve();
  #closed = false;
  #unsubscribeBrowserEvent?: () => void;
  #unsubscribeBrowserClose?: () => void;

  constructor(options: WorkbenchStreamControllerOptions) {
    this.#options = options;
    this.#state = options.enabled ? "idle" : "disabled";
    this.#server.on("connection", (socket) => this.#onConnection(socket));
  }

  get enabled(): boolean {
    return this.#options.enabled;
  }

  status(gatewayOrigin?: string): WorkbenchStreamStatus {
    const websocketUrl = this.#options.enabled && gatewayOrigin
      ? this.#websocketUrl(gatewayOrigin)
      : undefined;
    return {
      enabled: this.#options.enabled,
      experimental: true,
      state: this.#state,
      ...(websocketUrl ? { websocketUrl } : {}),
      ...(this.#browser?.browser ? { browser: this.#browser.browser } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.#options.enabled || this.#closed) {
      rejectUpgrade(socket, 404, "Streaming is disabled");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/stream" || !safeTokenEqual(url.searchParams.get("token"), this.#token)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (this.#viewer && this.#viewer.readyState !== WebSocket.CLOSED) {
      rejectUpgrade(socket, 409, "A stream viewer is already connected");
      return;
    }
    this.#server.handleUpgrade(request, socket, head, (client) => {
      this.#server.emit("connection", client, request);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = "stopped";
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    this.#ackPendingFrame();
    this.#viewer?.close(1001, "server shutting down");
    this.#viewer = undefined;
    this.#unsubscribeBrowserEvent?.();
    this.#unsubscribeBrowserClose?.();
    const browser = this.#browser ?? await this.#browserPromise?.catch(() => undefined);
    this.#browser = undefined;
    this.#browserPromise = undefined;
    await browser?.close().catch(() => undefined);
    this.#server.close();
  }

  #websocketUrl(gatewayOrigin: string): string {
    const url = new URL("/stream", gatewayOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", this.#token);
    return url.toString();
  }

  #onConnection(socket: WebSocket): void {
    this.#viewer = socket;
    socket.on("message", (raw) => this.#onViewerMessage(socket, raw));
    socket.once("close", () => {
      if (this.#viewer !== socket) return;
      this.#viewer = undefined;
      void this.#stopScreencast();
    });
    socket.once("error", () => {
      // The close event performs viewer cleanup.
    });
    this.#sendStatus(socket);
    void this.#startViewer(socket);
  }

  async #startViewer(socket: WebSocket): Promise<void> {
    try {
      const browser = await this.#ensureBrowser();
      if (this.#viewer !== socket || socket.readyState !== WebSocket.OPEN) return;
      await this.#configureViewport(browser, this.#viewport.width, this.#viewport.height);
      if (this.#viewer !== socket || socket.readyState !== WebSocket.OPEN) return;
      this.#send(socket, {
        type: "hello",
        protocol: WORKBENCH_STREAM_PROTOCOL_VERSION,
        ...this.#viewport,
      });
      await this.#startScreencast(browser);
      this.#state = "ready";
      this.#sendStatus(socket);
    } catch (error) {
      const unavailable = error instanceof StreamUnavailableError;
      this.#state = unavailable ? "unavailable" : "failed";
      this.#error = describeError(error);
      this.#send(socket, {
        type: "error",
        code: unavailable ? "STREAM_BROWSER_UNAVAILABLE" : "STREAM_START_FAILED",
        message: this.#error,
      });
    }
  }

  async #ensureBrowser(): Promise<StreamBrowserSession> {
    if (this.#browser) return this.#browser;
    if (this.#browserPromise) return await this.#browserPromise;
    const target = this.#options.runtime.target;
    if (!target || this.#options.runtime.status().state !== "ready") {
      throw new StreamUnavailableError("OpenVSCode is not ready for streaming");
    }
    const targetUrl = new URL(`${this.#options.runtime.basePath}/`, ensureTrailingSlash(target)).toString();
    this.#state = "starting";
    this.#error = undefined;
    const launcher = this.#options.launchBrowser ?? launchSystemChromium;
    this.#browserPromise = launcher({
      targetUrl,
      ...(this.#options.browserExecutable ? { browserExecutable: this.#options.browserExecutable } : {}),
      noSandbox: this.#options.noSandbox ?? false,
      ...this.#viewport,
    });
    try {
      const browser = await this.#browserPromise;
      if (this.#closed) {
        await browser.close();
        throw new Error("Stream controller closed while Chromium was starting");
      }
      this.#browser = browser;
      this.#unsubscribeBrowserEvent = browser.onEvent((method, params) => {
        if (method === "Page.screencastFrame") this.#onScreencastFrame(params);
      });
      this.#unsubscribeBrowserClose = browser.onClose((error) => {
        if (this.#closed) return;
        const failedBrowser = this.#browser;
        this.#screencastRunning = false;
        if (this.#frameTimer) {
          clearTimeout(this.#frameTimer);
          this.#frameTimer = undefined;
        }
        this.#ackPendingFrame();
        this.#unsubscribeBrowserEvent?.();
        this.#unsubscribeBrowserEvent = undefined;
        this.#unsubscribeBrowserClose = undefined;
        this.#browser = undefined;
        this.#browserPromise = undefined;
        this.#state = "failed";
        this.#error = error?.message ?? "Streaming Chromium exited unexpectedly";
        if (this.#viewer) {
          this.#send(this.#viewer, { type: "error", code: "STREAM_BROWSER_EXITED", message: this.#error });
        }
        // CDP normally closes because Chromium exited, but `close()` also
        // performs the essential ephemeral-profile cleanup.
        void failedBrowser?.close().catch(() => undefined);
      });
      return browser;
    } catch (error) {
      this.#browserPromise = undefined;
      throw error;
    }
  }

  async #startScreencast(browser: StreamBrowserSession): Promise<void> {
    if (this.#screencastRunning) return;
    await browser.send("Page.startScreencast", {
      format: "jpeg",
      quality: clampInteger(this.#options.jpegQuality ?? DEFAULT_JPEG_QUALITY, 20, 90),
      maxWidth: this.#viewport.width,
      maxHeight: this.#viewport.height,
      everyNthFrame: 1,
    });
    this.#screencastRunning = true;
  }

  async #stopScreencast(): Promise<void> {
    if (!this.#browser || !this.#screencastRunning) return;
    this.#screencastRunning = false;
    if (this.#frameTimer) {
      clearTimeout(this.#frameTimer);
      this.#frameTimer = undefined;
    }
    this.#ackPendingFrame();
    await this.#browser.send("Page.stopScreencast").catch(() => undefined);
  }

  #onScreencastFrame(params: Record<string, unknown>): void {
    const browser = this.#browser;
    if (!browser || !this.#screencastRunning) return;
    const data = typeof params.data === "string" ? params.data : undefined;
    const frameSessionId = typeof params.sessionId === "number" ? params.sessionId : undefined;
    if (!data || frameSessionId === undefined) return;
    const frameRate = clampInteger(this.#options.frameRate ?? DEFAULT_FRAME_RATE, 1, 30);
    const delayMs = Math.max(0, Math.ceil(1_000 / frameRate) - (Date.now() - this.#lastFrameAt));
    this.#pendingFrameAck = { browser, sessionId: frameSessionId };
    const deliver = () => {
      this.#frameTimer = undefined;
      if (this.#viewer?.readyState === WebSocket.OPEN) {
        this.#lastFrameAt = Date.now();
        this.#send(this.#viewer, {
          type: "frame",
          sequence: ++this.#sequence,
          format: "jpeg",
          data,
          ...this.#viewport,
        });
      }
      this.#ackPendingFrame();
    };
    if (delayMs === 0) deliver();
    else this.#frameTimer = setTimeout(deliver, delayMs);
  }

  #ackPendingFrame(): void {
    const pending = this.#pendingFrameAck;
    this.#pendingFrameAck = undefined;
    if (pending) {
      void pending.browser.send("Page.screencastFrameAck", { sessionId: pending.sessionId }).catch(() => undefined);
    }
  }

  #onViewerMessage(socket: WebSocket, raw: RawData): void {
    if (this.#viewer !== socket) return;
    let value: unknown;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      this.#send(socket, { type: "error", code: "BAD_STREAM_MESSAGE", message: "Stream message must be valid JSON" });
      return;
    }
    const message = parseClientMessage(value);
    if (!message) {
      this.#send(socket, { type: "error", code: "BAD_STREAM_MESSAGE", message: "Unsupported or invalid stream message" });
      return;
    }
    void this.#dispatchInput(message).catch((error) => {
      this.#send(socket, { type: "error", code: "STREAM_INPUT_FAILED", message: describeError(error) });
    });
  }

  async #dispatchInput(message: WorkbenchStreamClientMessage): Promise<void> {
    const browser = this.#browser;
    if (!browser) return;
    if (message.type === "resize") {
      const width = clampInteger(message.width, STREAM_VIEWPORT_LIMITS.minWidth, STREAM_VIEWPORT_LIMITS.maxWidth);
      const height = clampInteger(message.height, STREAM_VIEWPORT_LIMITS.minHeight, STREAM_VIEWPORT_LIMITS.maxHeight);
      if (width === this.#viewport.width && height === this.#viewport.height) return;
      this.#resizeQueue = this.#resizeQueue.catch(() => undefined).then(async () => {
        await this.#stopScreencast();
        await this.#configureViewport(browser, width, height);
        this.#viewport = { width, height };
        if (this.#viewer) {
          this.#send(this.#viewer, { type: "hello", protocol: WORKBENCH_STREAM_PROTOCOL_VERSION, width, height });
          await this.#startScreencast(browser);
        }
      });
      await this.#resizeQueue;
      return;
    }
    if (message.type === "pointer") {
      const type = message.event === "move" ? "mouseMoved" : message.event === "down" ? "mousePressed" : "mouseReleased";
      await browser.send("Input.dispatchMouseEvent", {
        type,
        x: clampNumber(message.x, 0, this.#viewport.width),
        y: clampNumber(message.y, 0, this.#viewport.height),
        button: message.button,
        buttons: clampInteger(message.buttons, 0, 31),
        clickCount: clampInteger(message.clickCount, 0, 3),
        modifiers: modifierMask(message),
        pointerType: "mouse",
      });
      return;
    }
    if (message.type === "wheel") {
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: clampNumber(message.x, 0, this.#viewport.width),
        y: clampNumber(message.y, 0, this.#viewport.height),
        deltaX: clampNumber(message.deltaX, -10_000, 10_000),
        deltaY: clampNumber(message.deltaY, -10_000, 10_000),
        modifiers: modifierMask(message),
      });
      return;
    }
    if (message.type === "text") {
      await browser.send("Input.insertText", { text: message.text });
      return;
    }

    const printable = message.key.length === 1 && !message.ctrlKey && !message.metaKey && !message.altKey;
    await browser.send("Input.dispatchKeyEvent", {
      type: message.event === "up" ? "keyUp" : printable ? "keyDown" : "rawKeyDown",
      key: message.key,
      code: message.code,
      windowsVirtualKeyCode: clampInteger(message.keyCode, 0, 255),
      nativeVirtualKeyCode: clampInteger(message.keyCode, 0, 255),
      location: clampInteger(message.location, 0, 3),
      autoRepeat: message.repeat,
      isKeypad: message.location === 3,
      modifiers: modifierMask(message),
      ...(message.event === "down" && printable ? { text: message.key, unmodifiedText: message.key } : {}),
    });
  }

  async #configureViewport(browser: StreamBrowserSession, width: number, height: number): Promise<void> {
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
  }

  #sendStatus(socket: WebSocket): void {
    const state = this.#state === "disabled" ? "stopped" : this.#state;
    this.#send(socket, {
      type: "status",
      state,
      ...(this.#error ? { message: this.#error } : {}),
    });
  }

  #send(socket: WebSocket, message: WorkbenchStreamServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }
}

export class StreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamUnavailableError";
  }
}

/** Launch Chromium with an ephemeral profile and attach through loopback CDP. */
export async function launchSystemChromium(options: {
  targetUrl: string;
  browserExecutable?: string;
  noSandbox: boolean;
  width: number;
  height: number;
}): Promise<StreamBrowserSession> {
  const executable = await discoverChromiumExecutable({ override: options.browserExecutable });
  if (!executable) {
    throw new StreamUnavailableError(
      options.browserExecutable
        ? "The browser configured by MCP_VSCODE_STREAM_BROWSER does not exist or is not executable"
        : "No installed Edge, Chrome, or Chromium browser was found for experimental streaming",
    );
  }

  const identity = await resolveChromiumIdentity(options.noSandbox);
  // A root process may inherit TMPDIR=/root/... from its supervisor. Chowning
  // only a leaf there would still leave the dropped browser unable to traverse
  // its ancestors. POSIX /tmp is the shared, traversable base for this one
  // high-entropy 0700 tree; other launch identities retain Node's temp path.
  const tempBase = identity.kind === "drop"
    ? await validatedDropTempBase("/tmp", identity)
    : os.tmpdir();
  const profileDir = await mkdtemp(path.join(tempBase, "mcp-vscode-stream-"));
  const args = [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    `--window-size=${options.width},${options.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    ...(options.noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const stderr: string[] = [];
  let child: ChildProcess | undefined;
  try {
    const profile = await prepareChromiumProfile(profileDir, identity);
    child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: profile.environment,
      ...(profile.cwd ? { cwd: profile.cwd } : {}),
      ...(identity.kind === "drop" ? { uid: identity.uid, gid: identity.gid } : {}),
    } satisfies SpawnOptions);
    // Keep post-start OS/process errors from becoming unhandled EventEmitter
    // errors. Startup failures are still captured and surfaced by
    // `waitForDevTools` below.
    child.on("error", () => undefined);
    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        stderr.push(line);
        if (stderr.length > 20) stderr.shift();
      }
    });

    const { websocketUrl } = await waitForDevTools(child, profileDir, CDP_TIMEOUT_MS, stderr);
    const connection = await CdpConnection.connect(websocketUrl, CDP_TIMEOUT_MS);
    const created = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    await connection.send("Page.enable", {}, sessionId);
    await connection.send("Runtime.enable", {}, sessionId);
    await connection.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: options.width,
      screenHeight: options.height,
    }, sessionId);
    await connection.send("Page.navigate", { url: options.targetUrl }, sessionId);
    await waitForPageReady(connection, sessionId, CDP_TIMEOUT_MS);
    await connection.send("Page.bringToFront", {}, sessionId);
    return new ChromiumStreamSession(executable, profileDir, child, connection, sessionId);
  } catch (error) {
    if (child) await stopBrowser(child, profileDir);
    else await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    throw error;
  }
}

async function resolveChromiumIdentity(noSandbox: boolean): Promise<ChromiumIdentityDecision> {
  const platform = process.platform;
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  let passwd: string | undefined;
  if (platform !== "win32" && effectiveUid === 0 && !noSandbox) {
    try {
      passwd = await readFile("/etc/passwd", "utf8");
    } catch (error) {
      throw new StreamUnavailableError(
        "Sandboxed streaming Chromium cannot start while mcp-vscode runs as root because /etc/passwd "
        + `could not be read (${describeError(error)}). Run mcp-vscode as non-root or provide a safe `
        + "node account; MCP_VSCODE_STREAM_NO_SANDBOX=1 is an explicit unsafe last resort and is never enabled automatically.",
      );
    }
  }
  const identity = selectChromiumIdentity({ platform, effectiveUid, noSandbox, passwd });
  if (identity.kind === "unavailable") throw new StreamUnavailableError(identity.reason);
  return identity;
}

async function prepareChromiumProfile(
  profileDir: string,
  identity: ChromiumIdentityDecision,
): Promise<{ environment: NodeJS.ProcessEnv; cwd?: string }> {
  if (process.platform === "win32") return { environment: process.env };

  const home = path.join(profileDir, "home");
  const xdgConfig = path.join(profileDir, "xdg-config");
  const xdgCache = path.join(profileDir, "xdg-cache");
  const xdgData = path.join(profileDir, "xdg-data");
  const xdgState = path.join(profileDir, "xdg-state");
  const xdgRuntime = path.join(profileDir, "xdg-runtime");
  const temp = path.join(profileDir, "tmp");
  const isolatedDirectories = [home, xdgConfig, xdgCache, xdgData, xdgState, xdgRuntime, temp];
  try {
    await Promise.all(isolatedDirectories.map(async (directory) => {
      await mkdir(directory, { mode: 0o700 });
    }));

    if (identity.kind === "drop") {
      // The root parent creates the private profile, then transfers only this
      // ephemeral tree before spawning Chromium with setgid/setuid. Chown the
      // descendants first and their session root last; the browser is not
      // spawned until the complete tree is ready.
      await Promise.all(isolatedDirectories.map(async (directory) => {
        await chown(directory, identity.uid, identity.gid);
      }));
      await chown(profileDir, identity.uid, identity.gid);
    }
  } catch (error) {
    if (identity.kind === "drop") {
      throw new StreamUnavailableError(
        `Unable to prepare Chromium's unprivileged ephemeral profile (${describeError(error)}). `
        + "Run mcp-vscode as non-root or grant the root parent permission to chown the profile to node; "
        + "MCP_VSCODE_STREAM_NO_SANDBOX=1 is an explicit unsafe last resort and is never enabled automatically.",
      );
    }
    throw error;
  }

  return {
    cwd: home,
    environment: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      XDG_RUNTIME_DIR: xdgRuntime,
      ...(identity.kind === "drop" ? { USER: identity.username, LOGNAME: identity.username } : {}),
    },
  };
}

async function validatedDropTempBase(
  candidate: string,
  identity: Extract<ChromiumIdentityDecision, { kind: "drop" }>,
): Promise<string> {
  try {
    const resolved = await realpath(candidate);
    const ancestors: string[] = [];
    for (let current = path.resolve(resolved);;) {
      ancestors.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const directory of ancestors.reverse()) {
      const metadata = await stat(directory);
      if (!metadata.isDirectory() || !isSafeSharedTempDirectory(identity, metadata)) {
        throw new Error(
          `${directory} is not a root-owned, traversable directory with safe sticky-bit semantics`,
        );
      }
    }
    return resolved;
  } catch (error) {
    throw new StreamUnavailableError(
      `Sandboxed streaming Chromium cannot use the shared POSIX temp directory (${describeError(error)}). `
      + "Provide a traversable /tmp and a safe node account, or run mcp-vscode as non-root; "
      + "MCP_VSCODE_STREAM_NO_SANDBOX=1 is an explicit unsafe last resort and is never enabled automatically.",
    );
  }
}

class ChromiumStreamSession implements StreamBrowserSession {
  readonly browser: string;
  readonly sessionId: string;
  readonly processId?: number;
  readonly profileDirectory: string;
  readonly #profileDir: string;
  readonly #child: ChildProcess;
  readonly #connection: CdpConnection;
  #closed = false;

  constructor(
    browser: string,
    profileDir: string,
    child: ChildProcess,
    connection: CdpConnection,
    sessionId: string,
  ) {
    this.browser = browser;
    this.processId = child.pid;
    this.profileDirectory = profileDir;
    this.#profileDir = profileDir;
    this.#child = child;
    this.#connection = connection;
    this.sessionId = sessionId;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#connection.send<T>(method, params, this.sessionId);
  }

  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    return this.#connection.onEvent((method, params, sessionId) => {
      if (sessionId === this.sessionId) listener(method, params);
    });
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.#connection.onClose(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Asking the browser process to shut down through its browser-level CDP
    // session lets it reap renderer children and release the profile cleanly,
    // especially on Windows. The connection often closes before this command
    // receives a response, which is an expected rejection.
    await this.#connection.send("Browser.close").catch(() => undefined);
    this.#connection.close();
    await stopBrowser(this.#child, this.#profileDir);
  }
}

interface CdpResponse {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

class CdpConnection {
  readonly #socket: WebSocket;
  #nextId = 0;
  #closed = false;
  #pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  #eventListeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();
  #closeListeners = new Set<(error?: Error) => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (raw) => this.#onMessage(raw));
    socket.once("close", () => this.#onClose());
    socket.once("error", (error) => this.#onClose(error));
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CdpConnection(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Chromium DevTools connection is closed"));
    }
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chromium DevTools command timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close(1000, "stream controller closed");
    }
    this.#onClose();
  }

  #onMessage(raw: RawData): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw.toString()) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Chromium DevTools error: ${message.error.message ?? message.error.code ?? "unknown"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of [...this.#eventListeners]) {
        listener(message.method, message.params ?? {}, message.sessionId);
      }
    }
  }

  #onClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const failure = error ?? new Error("Chromium DevTools connection closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.#pending.clear();
    for (const listener of [...this.#closeListeners]) listener(error);
  }
}

async function waitForDevTools(
  child: ChildProcess,
  profileDir: string,
  timeoutMs: number,
  stderr: string[],
): Promise<{ websocketUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  const activePortFile = path.join(profileDir, "DevToolsActivePort");
  let spawnError: Error | undefined;
  const onError = (error: Error) => {
    spawnError = error;
  };
  child.once("error", onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`Unable to launch streaming Chromium: ${spawnError.message}`);
      if (hasExited(child)) {
        throw new Error(`Streaming Chromium exited during startup${stderr.length ? `: ${stderr.at(-1)}` : ""}`);
      }
      try {
        const [portLine, websocketPath] = (await readFile(activePortFile, "utf8")).trim().split(/\r?\n/);
        const port = Number.parseInt(portLine ?? "", 10);
        if (Number.isInteger(port) && port > 0 && websocketPath?.startsWith("/devtools/browser/")) {
          return { websocketUrl: `ws://127.0.0.1:${port}${websocketPath}` };
        }
      } catch {
        // Chromium creates the file only after its loopback CDP listener is ready.
      }
      await delay(50);
    }
    throw new Error(`Streaming Chromium did not expose loopback DevTools within ${timeoutMs}ms${stderr.length ? `: ${stderr.at(-1)}` : ""}`);
  } finally {
    child.off("error", onError);
  }
}

async function waitForPageReady(
  connection: CdpConnection,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await connection.send<{
        result?: { value?: unknown };
      }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      }, sessionId);
      if (result.result?.value === "interactive" || result.result?.value === "complete") return;
    } catch (error) {
      // A freshly-created target can briefly report that it is not active.
      // Retry until the bounded startup deadline rather than racing the first
      // screencast command against navigation.
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(
    `Streaming Chromium page did not become ready within ${timeoutMs}ms${lastError ? `: ${describeError(lastError)}` : ""}`,
  );
}

async function stopBrowser(child: ChildProcess, profileDir: string): Promise<void> {
  if (!hasExited(child)) {
    child.kill("SIGTERM");
    await waitForChildExit(child, 3_000);
    if (!hasExited(child)) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 1_000);
    }
  }
  await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(timeoutMs),
  ]);
}

function parseClientMessage(value: unknown): WorkbenchStreamClientMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "resize") {
    if (!finite(value.width) || !finite(value.height)) return undefined;
    return { type: "resize", width: value.width, height: value.height };
  }
  if (value.type === "text") {
    if (typeof value.text !== "string" || value.text.length > STREAM_TEXT_LIMIT) return undefined;
    return { type: "text", text: value.text };
  }
  if (value.type === "pointer") {
    if (!(["move", "down", "up"] as unknown[]).includes(value.event)
      || !finite(value.x) || !finite(value.y)
      || !isMouseButton(value.button) || !finite(value.buttons) || !finite(value.clickCount)
      || !hasModifiers(value)) return undefined;
    return {
      type: "pointer",
      event: value.event as "move" | "down" | "up",
      x: value.x,
      y: value.y,
      button: value.button,
      buttons: value.buttons,
      clickCount: value.clickCount,
      ...pickModifiers(value),
    };
  }
  if (value.type === "wheel") {
    if (!finite(value.x) || !finite(value.y) || !finite(value.deltaX) || !finite(value.deltaY) || !hasModifiers(value)) {
      return undefined;
    }
    return {
      type: "wheel",
      x: value.x,
      y: value.y,
      deltaX: value.deltaX,
      deltaY: value.deltaY,
      ...pickModifiers(value),
    };
  }
  if (value.type === "key") {
    if (!(["down", "up"] as unknown[]).includes(value.event)
      || typeof value.key !== "string" || value.key.length > 64
      || typeof value.code !== "string" || value.code.length > 64
      || !finite(value.keyCode) || !finite(value.location)
      || typeof value.repeat !== "boolean" || !hasModifiers(value)) return undefined;
    return {
      type: "key",
      event: value.event as "down" | "up",
      key: value.key,
      code: value.code,
      keyCode: value.keyCode,
      location: value.location,
      repeat: value.repeat,
      ...pickModifiers(value),
    };
  }
  return undefined;
}

function hasModifiers(value: Record<string, unknown>): boolean {
  return [value.altKey, value.ctrlKey, value.metaKey, value.shiftKey].every((entry) => typeof entry === "boolean");
}

function pickModifiers(value: Record<string, unknown>) {
  return {
    altKey: value.altKey as boolean,
    ctrlKey: value.ctrlKey as boolean,
    metaKey: value.metaKey as boolean,
    shiftKey: value.shiftKey as boolean,
  };
}

function modifierMask(value: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (value.altKey ? 1 : 0) | (value.ctrlKey ? 2 : 0) | (value.metaKey ? 4 : 0) | (value.shiftKey ? 8 : 0);
}

function isMouseButton(value: unknown): value is StreamMouseButton {
  return ["none", "left", "middle", "right", "back", "forward"].includes(String(value));
}

function safeTokenEqual(value: string | null, expected: string): boolean {
  if (!value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
