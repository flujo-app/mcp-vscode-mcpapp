import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import WebSocket from "ws";
import { selectTier, type SessionPayload, type Tier } from "../src/app/tier.js";
import { UiTransport } from "../src/app/transport.js";
import { VscodeCore } from "../src/core/core.js";
import { Gateway } from "../src/http/gateway.js";
import { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

const FAST_TIMEOUT_MS = 1_000;

class WindowHarness extends EventTarget {
  constructor(private readonly maximumDelayMs?: number) {
    super();
  }

  setTimeout(handler: TimerHandler, timeout = 0, ...args: unknown[]): number {
    const delay = this.maximumDelayMs === undefined ? timeout : Math.min(timeout, this.maximumDelayMs);
    const callback = typeof handler === "function" ? () => handler(...args) : () => undefined;
    return globalThis.setTimeout(callback, delay) as unknown as number;
  }

  clearTimeout(handle?: number): void {
    globalThis.clearTimeout(handle as unknown as NodeJS.Timeout);
  }

  reportWorkbenchAlive(): void {
    const event = new Event("message") as MessageEvent;
    Object.defineProperty(event, "data", { value: { type: "mcp-vscode:workbench-alive" } });
    this.dispatchEvent(event);
  }
}

type FrameMode = "alive" | "blocked" | "error" | "throw";

class FrameHarness extends EventTarget {
  #src = "";

  constructor(
    private readonly browserWindow: WindowHarness,
    private readonly mode: FrameMode,
  ) {
    super();
  }

  get src(): string {
    return this.#src;
  }

  set src(value: string) {
    if (this.mode === "throw") throw new Error("host rejected iframe navigation");
    this.#src = value;
    if (this.mode === "alive") {
      queueMicrotask(() => this.browserWindow.reportWorkbenchAlive());
    } else if (this.mode === "error") {
      queueMicrotask(() => this.dispatchEvent(new Event("error")));
    }
  }
}

interface GatewayContext {
  origin: string;
  session: SessionPayload;
  close(): Promise<void>;
}

async function startGateway(withManifest = true): Promise<GatewayContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-tier-"));
  const workspace = path.join(root, "workspace");
  const assets = path.join(root, "assets");
  await mkdir(workspace);
  await mkdir(assets);
  if (withManifest) await writeFile(path.join(assets, "manifest.json"), "{}\n");

  const core = new VscodeCore(workspace);
  await core.initialize();
  const runtime = new OpenVscodeRuntime({ core, workspaceRoot: workspace });
  const gateway = new Gateway({
    core,
    runtime,
    host: "127.0.0.1",
    port: 0,
    appHtmlPath: path.resolve("src/app/index.html"),
    assetsRoot: assets,
  });
  const started = await gateway.start();

  return {
    origin: started.origin,
    session: {
      gatewayOrigin: started.origin,
      assetsUrl: `${started.origin}/assets`,
      uiToken: core.bridgeToken,
      ideUrl: `${started.origin}/workbench/`,
    },
    async close() {
      runtime.close();
      await core.close();
      await gateway.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function installBrowserGlobals(
  t: TestContext,
  browserWindow: WindowHarness,
  webSocket: unknown = WebSocket,
): void {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: browserWindow });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: webSocket });
  t.after(() => {
    restoreGlobal("window", windowDescriptor);
    restoreGlobal("WebSocket", webSocketDescriptor);
  });
}

function restoreGlobal(name: "window" | "WebSocket", descriptor?: PropertyDescriptor): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

interface MatrixRow {
  name: string;
  manifest?: boolean;
  frame: FrameMode;
  expected: Tier;
  session?(session: SessionPayload): SessionPayload;
}

const matrix: MatrixRow[] = [
  {
    name: "native wins when both the native surface and iframe are available",
    frame: "alive",
    expected: "native",
  },
  {
    name: "native remains available while the OpenVSCode runtime reports starting",
    frame: "blocked",
    expected: "native",
    session: (session) => ({ ...session, openVscode: { state: "starting" }, ideUrl: undefined }),
  },
  {
    name: "a missing asset manifest falls forward to an alive iframe",
    manifest: false,
    frame: "alive",
    expected: "embedded",
  },
  {
    name: "a rejected UI socket falls forward to an alive iframe",
    frame: "alive",
    expected: "embedded",
    session: (session) => ({ ...session, uiToken: "incorrect-token" }),
  },
  {
    name: "missing native session metadata falls forward to an alive iframe",
    frame: "alive",
    expected: "embedded",
    session: (session) => ({ ...session, gatewayOrigin: undefined, uiToken: undefined, assetsUrl: undefined }),
  },
  {
    name: "browserUrl is accepted as the iframe fallback URL",
    frame: "alive",
    expected: "embedded",
    session: (session) => ({
      ...session,
      gatewayOrigin: undefined,
      uiToken: undefined,
      assetsUrl: undefined,
      ideUrl: undefined,
      openVscode: { browserUrl: session.ideUrl },
    }),
  },
  {
    name: "native failure and a frame-policy timeout commit the browser tier",
    manifest: false,
    frame: "blocked",
    expected: "browser",
    session: (session) => ({ ...session, uiToken: "incorrect-token" }),
  },
  {
    name: "an iframe error commits the browser tier without waiting for the timeout",
    frame: "error",
    expected: "browser",
    session: (session) => ({ ...session, uiToken: "incorrect-token" }),
  },
  {
    name: "no native metadata and no workbench URL commits the browser tier",
    frame: "blocked",
    expected: "browser",
    session: () => ({ openVscode: { state: "starting" } }),
  },
  {
    name: "a host exception while assigning iframe.src fails forward to browser",
    frame: "throw",
    expected: "browser",
    session: (session) => ({ ...session, uiToken: "incorrect-token" }),
  },
  {
    name: "an invalid gateway origin cannot reject the tier chain",
    frame: "alive",
    expected: "embedded",
    session: (session) => ({ ...session, gatewayOrigin: "not a URL", assetsUrl: "not a URL" }),
  },
  {
    name: "assets alone are insufficient when the authenticated UI socket is unavailable",
    frame: "blocked",
    expected: "browser",
    session: (session) => ({ ...session, uiToken: "incorrect-token" }),
  },
  {
    name: "the UI socket alone is insufficient when the asset manifest is unavailable",
    manifest: false,
    frame: "blocked",
    expected: "browser",
  },
  {
    name: "a framing-blocked host still uses native when connect and resource access work",
    frame: "blocked",
    expected: "native",
  },
];

test("automatic native -> embedded -> browser selection covers the 14 host permutations", async (t) => {
  const previousDisablePty = process.env.MCP_VSCODE_DISABLE_PTY;
  process.env.MCP_VSCODE_DISABLE_PTY = "1";
  t.after(() => {
    if (previousDisablePty === undefined) delete process.env.MCP_VSCODE_DISABLE_PTY;
    else process.env.MCP_VSCODE_DISABLE_PTY = previousDisablePty;
  });

  for (const row of matrix) {
    await t.test(row.name, async (t) => {
      const gateway = await startGateway(row.manifest ?? true);
      t.after(() => gateway.close());
      const browserWindow = new WindowHarness();
      installBrowserGlobals(t, browserWindow);
      const frame = new FrameHarness(browserWindow, row.frame);
      const session = row.session?.(gateway.session) ?? gateway.session;

      const result = await selectTier(session, frame as unknown as HTMLIFrameElement, {
        nativeTimeoutMs: FAST_TIMEOUT_MS,
        embeddedTimeoutMs: FAST_TIMEOUT_MS,
      });

      assert.equal(result.tier, row.expected);
      assert.ok(result.reason.length > 0);
    });
  }
});

test("a hanging UI socket probe times out and still commits a fallback tier", async (t) => {
  class HangingWebSocket extends EventTarget {
    close(): void {
      // Intentionally never emits open, error, or close.
    }
  }

  const gateway = await startGateway();
  t.after(() => gateway.close());
  const browserWindow = new WindowHarness();
  installBrowserGlobals(t, browserWindow, HangingWebSocket);
  const frame = new FrameHarness(browserWindow, "blocked");
  const result = await selectTier(
    { ...gateway.session, ideUrl: undefined },
    frame as unknown as HTMLIFrameElement,
    { nativeTimeoutMs: 5, embeddedTimeoutMs: 5 },
  );
  assert.equal(result.tier, "browser");
});

test("a changed gateway origin is re-probed instead of reusing the previous native decision", async (t) => {
  const first = await startGateway();
  const second = await startGateway();
  t.after(async () => {
    await first.close();
    await second.close();
  });
  assert.notEqual(first.origin, second.origin);
  const browserWindow = new WindowHarness();
  installBrowserGlobals(t, browserWindow);
  const frame = new FrameHarness(browserWindow, "blocked") as unknown as HTMLIFrameElement;

  assert.equal((await selectTier(first.session, frame, { nativeTimeoutMs: FAST_TIMEOUT_MS })).tier, "native");
  assert.equal((await selectTier(second.session, frame, { nativeTimeoutMs: FAST_TIMEOUT_MS })).tier, "native");
});

test("UiTransport emits give-up after repeated failures so the caller can run a full re-probe", async (t) => {
  let attempts = 0;
  class FailingWebSocket extends EventTarget {
    static readonly OPEN = 1;
    readonly readyState = 0;

    constructor(_url: string) {
      super();
      attempts += 1;
      queueMicrotask(() => this.dispatchEvent(new Event("close")));
    }

    close(): void {}
    send(): void {}
  }

  const browserWindow = new WindowHarness(1);
  installBrowserGlobals(t, browserWindow, FailingWebSocket);
  const transport = new UiTransport("ws://127.0.0.1:1/ui?token=unused");
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => reject(new Error("give-up callback was not emitted")), 1_000);
      transport.onGiveUp = () => {
        globalThis.clearTimeout(timeout);
        resolve();
      };
      transport.connect();
    });

    assert.equal(attempts, 3);
    const result = await selectTier({}, new FrameHarness(browserWindow, "blocked") as unknown as HTMLIFrameElement, {
      nativeTimeoutMs: 5,
      embeddedTimeoutMs: 5,
    });
    assert.equal(result.tier, "browser");
  } finally {
    transport.close();
  }
});
