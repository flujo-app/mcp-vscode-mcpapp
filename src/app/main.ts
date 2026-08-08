import { App } from "@modelcontextprotocol/ext-apps";

declare global {
  interface Window {
    __MCP_VSCODE_DEBUG__?: SessionPayload;
  }
}

interface SessionPayload {
  workspaceRoot?: string;
  ideUrl?: string;
  gatewayOrigin?: string;
  uiToken?: string;
  assetsUrl?: string;
  bridge?: { connected?: boolean };
  openVscode?: {
    state?: string;
    error?: string;
    browserUrl?: string;
  };
}

const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `
  <main class="shell">
    <header class="titlebar">
      ${logo("mark")}
      <span class="title">MCP VS Code</span>
      <span class="subtitle" id="workspace">Connecting to workspace…</span>
      <span class="spacer"></span>
      <button id="reload" type="button" title="Reload the embedded workbench">Reload</button>
      <button id="fullscreen" type="button" title="Request fullscreen mode">Fullscreen</button>
    </header>
    <section class="frame-wrap">
      <iframe id="workbench" title="VS Code workbench" allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
      <div class="cover" id="cover">
        <div class="card">
          ${logo("large-mark")}
          <h1>Preparing VS Code</h1>
          <p class="message" id="message">Starting the bundled Code OSS workbench and bridge…</p>
          <div class="details" id="details"></div>
        </div>
      </div>
    </section>
    <footer class="statusbar" id="statusbar">
      <span class="status-item"><span class="dot"></span><span id="runtime-status">Starting</span></span>
      <span class="status-item">MCP bridge: <span id="bridge-status">waiting</span></span>
      <span class="status-item right" id="origin"></span>
    </footer>
  </main>`;

const frame = document.querySelector<HTMLIFrameElement>("#workbench")!;
const cover = document.querySelector<HTMLDivElement>("#cover")!;
const message = document.querySelector<HTMLParagraphElement>("#message")!;
const details = document.querySelector<HTMLDivElement>("#details")!;
const workspace = document.querySelector<HTMLSpanElement>("#workspace")!;
const runtimeStatus = document.querySelector<HTMLSpanElement>("#runtime-status")!;
const bridgeStatus = document.querySelector<HTMLSpanElement>("#bridge-status")!;
const origin = document.querySelector<HTMLSpanElement>("#origin")!;
const statusbar = document.querySelector<HTMLElement>("#statusbar")!;

let currentSession: SessionPayload | undefined;
let app: App | undefined;

document.querySelector<HTMLButtonElement>("#reload")!.onclick = () => {
  if (frame.src) frame.src = frame.src;
  else void refresh();
};
document.querySelector<HTMLButtonElement>("#fullscreen")!.onclick = async () => {
  if (!app) return;
  try {
    await app.requestDisplayMode({ mode: "fullscreen" });
  } catch (error) {
    showTransientError(error);
  }
};
frame.addEventListener("load", () => {
  if (frame.src) cover.hidden = true;
});
frame.addEventListener("error", () => {
  showError("The OpenVSCode frame failed to load.", "Check the MCP host's frameDomains policy and the HTTPS endpoint.");
});

if (window.__MCP_VSCODE_DEBUG__) {
  applySession(window.__MCP_VSCODE_DEBUG__);
  window.setInterval(() => void refreshDebug(), 2_000);
} else {
  void connectMcpApp();
}

async function connectMcpApp(): Promise<void> {
  app = new App(
    { name: "MCP VS Code", version: "0.1.0" },
    { availableDisplayModes: ["inline", "fullscreen", "pip"] },
  );
  app.ontoolresult = (result) => {
    const payload = result.structuredContent as SessionPayload | undefined;
    if (payload?.openVscode || payload?.ideUrl) applySession(payload);
  };
  app.onhostcontextchanged = (context) => {
    document.documentElement.dataset.theme = context.theme ?? "dark";
  };
  try {
    await app.connect();
    await refresh();
    window.setInterval(() => void refresh(), 2_000);
  } catch (error) {
    showError("This host did not initialize the MCP App.", error instanceof Error ? error.message : String(error));
  }
}

async function refresh(): Promise<void> {
  if (!app) return;
  try {
    const result = await app.callServerTool({ name: "workspace_status", arguments: {} });
    applySession(result.structuredContent as SessionPayload);
  } catch (error) {
    showTransientError(error);
  }
}

async function refreshDebug(): Promise<void> {
  const endpoint = new URL("/session.json", window.__MCP_VSCODE_DEBUG__?.gatewayOrigin ?? location.origin);
  const token = new URL(location.href).searchParams.get("token");
  if (token) endpoint.searchParams.set("token", token);
  try {
    const response = await fetch(endpoint);
    if (response.ok) applySession(await response.json() as SessionPayload);
  } catch {
    // The static debug view retains its last known state.
  }
}

function applySession(session: SessionPayload): void {
  currentSession = session;
  const state = session.openVscode?.state ?? "unknown";
  const ideUrl = session.ideUrl ?? session.openVscode?.browserUrl;
  workspace.textContent = session.workspaceRoot ?? "Workspace";
  runtimeStatus.textContent = state;
  bridgeStatus.textContent = session.bridge?.connected ? "connected" : "waiting";
  origin.textContent = session.gatewayOrigin ?? "";
  statusbar.classList.toggle("error", state === "failed" || state === "unavailable");

  if ((state === "ready" || ideUrl) && ideUrl) {
    if (frame.src !== ideUrl) {
      cover.hidden = false;
      message.textContent = "Loading the embedded workbench…";
      details.textContent = "";
      frame.src = ideUrl;
    }
    return;
  }
  cover.hidden = false;
  if (state === "unavailable" || state === "failed") {
    showError("The bundled OpenVSCode runtime is unavailable.", session.openVscode?.error ?? "Unknown runtime error");
  } else {
    message.textContent = "Starting the bundled Code OSS workbench and bridge…";
    details.textContent = "";
  }
}

function showError(summary: string, detail: string): void {
  cover.hidden = false;
  message.textContent = summary;
  details.textContent = detail;
  statusbar.classList.add("error");
}

function showTransientError(error: unknown): void {
  const previous = runtimeStatus.textContent;
  runtimeStatus.textContent = error instanceof Error ? error.message : String(error);
  window.setTimeout(() => {
    runtimeStatus.textContent = currentSession?.openVscode?.state ?? previous;
  }, 3_000);
}

function logo(className: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.4 2.2 8.5 10.3 4.1 7 2 8.1v7.8L4.1 17l4.4-3.3 8.9 8.1 4.6-2.2V4.4l-4.6-2.2Zm-.7 5.5v8.6l-5.5-4.3 5.5-4.3ZM4.8 12l2.5-1.9v3.8L4.8 12Z"/></svg>`;
}
