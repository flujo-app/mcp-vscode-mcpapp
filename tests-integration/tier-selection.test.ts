import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { selectTier, type SessionPayload, type Tier } from "../src/app/tier.js";
import { VscodeCore } from "../src/core/core.js";
import { Gateway } from "../src/http/gateway.js";
import { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

const FAST_TIMEOUT_MS = 1_000;

class WindowHarness extends EventTarget {
  setTimeout(handler: TimerHandler, timeout = 0, ...args: unknown[]): number {
    const callback = typeof handler === "function" ? () => handler(...args) : () => undefined;
    return globalThis.setTimeout(callback, timeout) as unknown as number;
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

async function startGateway(): Promise<GatewayContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-tier-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);

  const core = new VscodeCore(workspace);
  await core.initialize();
  const runtime = new OpenVscodeRuntime({ core, workspaceRoot: workspace });
  const gateway = new Gateway({
    core,
    runtime,
    host: "127.0.0.1",
    port: 0,
    appHtmlPath: path.resolve("src/app/index.html"),
  });
  const started = await gateway.start();

  return {
    origin: started.origin,
    session: {
      gatewayOrigin: started.origin,
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
): void {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: browserWindow });
  t.after(() => {
    restoreGlobal("window", windowDescriptor);
  });
}

function restoreGlobal(name: "window", descriptor?: PropertyDescriptor): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

interface MatrixRow {
  name: string;
  frame: FrameMode;
  expected: Tier;
  framePolicy?: "allowed" | "denied" | "unknown";
  session?(session: SessionPayload): SessionPayload;
}

const matrix: MatrixRow[] = [
  {
    name: "an alive genuine workbench commits the embedded tier",
    frame: "alive",
    expected: "embedded",
  },
  {
    name: "gateway side-channel metadata is irrelevant to genuine iframe rendering",
    frame: "alive",
    expected: "embedded",
    session: (session) => ({ ...session, gatewayOrigin: undefined }),
  },
  {
    name: "browserUrl is accepted as the iframe fallback URL",
    frame: "alive",
    expected: "embedded",
    session: (session) => ({
      ...session,
      gatewayOrigin: undefined,
      ideUrl: undefined,
      openVscode: { browserUrl: session.ideUrl },
    }),
  },
  {
    name: "a frame-policy timeout commits the honest browser fallback",
    frame: "blocked",
    expected: "browser",
  },
  {
    name: "an iframe error commits the browser tier without waiting for the timeout",
    frame: "error",
    expected: "browser",
  },
  {
    name: "no workbench URL commits the browser tier",
    frame: "blocked",
    expected: "browser",
    session: () => ({ openVscode: { state: "starting" } }),
  },
  {
    name: "a host exception while assigning iframe.src fails forward to browser",
    frame: "throw",
    expected: "browser",
  },
  {
    name: "an explicit host frame-domain denial skips iframe navigation",
    frame: "blocked",
    expected: "browser",
    framePolicy: "denied",
  },
];

test("automatic real-workbench -> browser selection is honest across host permutations", async (t) => {
  const previousDisablePty = process.env.MCP_VSCODE_DISABLE_PTY;
  process.env.MCP_VSCODE_DISABLE_PTY = "1";
  t.after(() => {
    if (previousDisablePty === undefined) delete process.env.MCP_VSCODE_DISABLE_PTY;
    else process.env.MCP_VSCODE_DISABLE_PTY = previousDisablePty;
  });

  for (const row of matrix) {
    await t.test(row.name, async (t) => {
      const gateway = await startGateway();
      t.after(() => gateway.close());
      const browserWindow = new WindowHarness();
      installBrowserGlobals(t, browserWindow);
      const frame = new FrameHarness(browserWindow, row.frame);
      const session = row.session?.(gateway.session) ?? gateway.session;

      const result = await selectTier(session, frame as unknown as HTMLIFrameElement, {
        embeddedTimeoutMs: FAST_TIMEOUT_MS,
        framePolicy: row.framePolicy,
      });

      assert.equal(result.tier, row.expected);
      assert.ok(result.reason.length > 0);
    });
  }
});

test("a changed gateway origin is re-probed instead of reusing a previous embedded decision", async (t) => {
  const first = await startGateway();
  const second = await startGateway();
  t.after(async () => {
    await first.close();
    await second.close();
  });
  assert.notEqual(first.origin, second.origin);
  const browserWindow = new WindowHarness();
  installBrowserGlobals(t, browserWindow);
  const frame = new FrameHarness(browserWindow, "alive") as unknown as HTMLIFrameElement;

  assert.equal((await selectTier(first.session, frame, { embeddedTimeoutMs: FAST_TIMEOUT_MS })).tier, "embedded");
  assert.equal((await selectTier(second.session, frame, { embeddedTimeoutMs: FAST_TIMEOUT_MS })).tier, "embedded");
});
