// MCP App entry point. This view renders the genuine OpenVSCode workbench or
// an explicit explanation that the host/network cannot embed it. It never
// substitutes a hand-built editor while continuing to call itself VS Code.
import { App } from "@modelcontextprotocol/ext-apps";
import {
  framePolicyForUrl,
  sessionWithAppMeta,
  selectTier,
  type FramePolicy,
  type SessionPayload,
  type Tier,
  type TierProbeResult,
} from "./tier.js";
import { StatusBar } from "./statusbar.js";
import { StreamedWorkbench } from "./streamed-workbench.js";

declare global {
  interface Window {
    __MCP_VSCODE_DEBUG__?: SessionPayload;
  }
}

const PROBE_WATCHDOG_MS = 20_000;

const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `
  <main class="shell">
    <header class="titlebar">
      ${logo("mark")}
      <span class="title">MCP VS Code</span>
      <span class="subtitle" id="workspace">Connecting to workspace…</span>
      <span class="spacer"></span>
      <button id="open-in-browser" type="button" title="Open the genuine workbench in your browser" disabled>Open in browser</button>
      <button id="reload" type="button" title="Reload">Reload</button>
      <button id="fullscreen" type="button" title="Request fullscreen mode">Fullscreen</button>
    </header>
    <section class="content">
      <iframe id="workbench" class="workbench-frame" hidden title="VS Code workbench" allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
      <div id="streamed-workbench" class="streamed-workbench-host" hidden></div>
      <div class="cover" id="cover">
        <div class="card">
          ${logo("large-mark")}
          <h1 id="cover-title">Preparing VS Code</h1>
          <p class="message" id="message">Starting the bundled Code OSS workbench and bridge…</p>
          <div class="details" id="details"></div>
          <a class="open-browser" id="open-browser" href="#" target="_blank" rel="noopener noreferrer" hidden>Open the real workbench</a>
        </div>
      </div>
    </section>
    <footer class="statusbar" id="statusbar">
      <span class="status-item"><span class="dot"></span><span id="runtime-status">Starting</span></span>
      <span class="status-item tier-badge" id="tier-badge">Detecting…</span>
      <span class="status-item">VS Code bridge: <span id="bridge-status">waiting</span></span>
      <span class="status-item right" id="origin"></span>
    </footer>
  </main>`;

const frame = document.querySelector<HTMLIFrameElement>("#workbench")!;
const streamRoot = document.querySelector<HTMLDivElement>("#streamed-workbench")!;
const cover = document.querySelector<HTMLDivElement>("#cover")!;
const coverTitle = document.querySelector<HTMLHeadingElement>("#cover-title")!;
const message = document.querySelector<HTMLParagraphElement>("#message")!;
const details = document.querySelector<HTMLDivElement>("#details")!;
const openBrowserLink = document.querySelector<HTMLAnchorElement>("#open-browser")!;
const openInBrowserButton = document.querySelector<HTMLButtonElement>("#open-in-browser")!;
const workspaceLabel = document.querySelector<HTMLSpanElement>("#workspace")!;
const runtimeStatus = document.querySelector<HTMLSpanElement>("#runtime-status")!;
const bridgeStatus = document.querySelector<HTMLSpanElement>("#bridge-status")!;
const origin = document.querySelector<HTMLSpanElement>("#origin")!;
const statusbar = document.querySelector<HTMLElement>("#statusbar")!;
const tierBadge = document.querySelector<HTMLElement>("#tier-badge")!;
const statusBar = new StatusBar(statusbar, tierBadge, bridgeStatus);

let app: App | undefined;
let currentSession: SessionPayload | undefined;
let tierState: Tier = "probing";
let probeToken = 0;
let watchdogTimer: number | undefined;
let lastCommittedOrigin: string | undefined;
let lastRuntimeState: string | undefined;
let streamedWorkbench: StreamedWorkbench | undefined;

document.querySelector<HTMLButtonElement>("#reload")!.onclick = () => void reloadCurrentTier();
document.querySelector<HTMLButtonElement>("#fullscreen")!.onclick = async () => {
  if (!app) return;
  try {
    await app.requestDisplayMode({ mode: "fullscreen" });
  } catch (error) {
    showTransientError(error);
  }
};
openInBrowserButton.onclick = () => void openInBrowser();
openBrowserLink.onclick = (event) => {
  event.preventDefault();
  void openInBrowser();
};

if (window.__MCP_VSCODE_DEBUG__) {
  applySession(window.__MCP_VSCODE_DEBUG__);
  window.setInterval(() => void refreshDebug(), 2_000);
} else {
  void connectMcpApp();
}

async function connectMcpApp(): Promise<void> {
  app = new App(
    { name: "MCP VS Code", version: "0.2.4" }, // x-release-please-version
    { availableDisplayModes: ["inline", "fullscreen", "pip"] },
  );
  app.ontoolresult = (result) => {
    const payload = sessionWithAppMeta(
      result.structuredContent as SessionPayload | undefined,
      result._meta,
    );
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
    showError("This host did not initialize the MCP App.", describeError(error));
  }
}

async function refresh(): Promise<void> {
  if (!app) return;
  try {
    const result = await app.callServerTool({ name: "workspace_status", arguments: {} });
    applySession(sessionWithAppMeta(result.structuredContent as SessionPayload, result._meta)!);
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
    if (response.ok) applySession((await response.json()) as SessionPayload);
  } catch {
    // The static debug view retains its last known state.
  }
}

function applySession(session: SessionPayload): void {
  currentSession = session;
  const state = session.openVscode?.state ?? "unknown";
  const previousState = lastRuntimeState;
  lastRuntimeState = state;
  workspaceLabel.textContent = session.workspaceRoot ?? "Workspace";
  runtimeStatus.textContent = state;
  origin.textContent = session.gatewayOrigin ?? "";
  statusBar.setConnection(session.bridge?.connected ? "open" : "waiting");
  statusBar.setError(state === "failed" || state === "unavailable");
  openInBrowserButton.disabled = !workbenchUrl(session);

  if (state === "failed" || state === "unavailable") {
    showError("The genuine OpenVSCode runtime is unavailable.", session.openVscode?.error ?? "Unknown runtime error");
    return;
  }

  if (state === "starting") {
    tierState = "probing";
    statusBar.setTier("probing", "waiting for the genuine OpenVSCode runtime to start");
    cover.hidden = false;
    coverTitle.textContent = "Starting VS Code";
    message.textContent = "Waiting for the bundled Code OSS workbench…";
    details.textContent = "";
    return;
  }

  const originChanged = lastCommittedOrigin !== undefined && lastCommittedOrigin !== session.gatewayOrigin;
  const becameReady = previousState === "starting" && state === "ready";
  if (tierState === "probing" && probeToken === 0) {
    void runProbe(session);
  } else if (originChanged || becameReady) {
    void reprobeFromScratch(
      session,
      originChanged ? "the gateway origin changed" : "the OpenVSCode runtime became ready",
    );
  }
}

function hostFramePolicy(session: SessionPayload): FramePolicy {
  const url = workbenchUrl(session);
  if (!url || !app) return "unknown";
  const sandboxCsp = app.getHostCapabilities()?.sandbox?.csp;
  return framePolicyForUrl(url, sandboxCsp?.frameDomains, sandboxCsp !== undefined);
}

async function runTierProbeWithLogging(session: SessionPayload): Promise<TierProbeResult> {
  if (session.stream?.enabled) {
    const result = await selectTier(session, frame);
    logTier(`experimental stream selection: ${result.tier} — ${result.reason}`);
    return result;
  }
  const url = workbenchUrl(session);
  if (!url) {
    logTier("real workbench probe skipped: no workbench URL is available yet");
    return { tier: "browser", reason: "no workbench URL is available yet" };
  }
  const framePolicy = hostFramePolicy(session);
  logTier(`host frameDomains decision for ${new URL(url).origin}: ${framePolicy}`);
  if (framePolicy === "denied") {
    return {
      tier: "browser",
      reason: "the MCP host did not approve the real workbench origin in frameDomains",
    };
  }
  logTier(`real workbench iframe probe starting at ${url}`);
  const result = await selectTier(session, frame, { framePolicy });
  logTier(`real workbench iframe probe result: ${result.tier} — ${result.reason}`);
  return result;
}

async function runProbe(session: SessionPayload): Promise<void> {
  const token = ++probeToken;
  tierState = "probing";
  statusBar.setTier("probing");
  cover.hidden = false;
  coverTitle.textContent = "Preparing VS Code";
  message.textContent = "Checking whether this host permits the genuine OpenVSCode workbench…";
  details.textContent = "";
  openBrowserLink.hidden = true;

  if (watchdogTimer !== undefined) window.clearTimeout(watchdogTimer);
  watchdogTimer = window.setTimeout(() => {
    if (token !== probeToken || tierState !== "probing") return;
    const reason = "the real-workbench probe timed out";
    logTier(reason, "warning");
    commitTier({ tier: "browser", reason }, session);
  }, PROBE_WATCHDOG_MS);

  const result = await runTierProbeWithLogging(session).catch((error): TierProbeResult => {
    const reason = `the real-workbench probe failed: ${describeError(error)}`;
    logTier(reason, "error");
    return { tier: "browser", reason };
  });
  if (token !== probeToken) return;
  commitTier(result, session);
}

function commitTier(result: TierProbeResult, session: SessionPayload): void {
  if (watchdogTimer !== undefined) window.clearTimeout(watchdogTimer);
  watchdogTimer = undefined;
  tierState = result.tier;
  lastCommittedOrigin = session.gatewayOrigin;
  logTier(`committing renderer "${result.tier}" — ${result.reason}`);
  statusBar.setTier(result.tier, result.reason);
  streamedWorkbench?.dispose();
  streamedWorkbench = undefined;
  streamRoot.hidden = true;

  if (result.tier === "stream") {
    frame.hidden = true;
    frame.src = "about:blank";
    void mountStream(session);
    return;
  }
  if (result.tier === "embedded") {
    frame.hidden = false;
    cover.hidden = true;
    return;
  }
  frame.hidden = true;
  frame.src = "about:blank";
  showBrowserCard(session, result.reason);
}

async function mountStream(session: SessionPayload): Promise<void> {
  const websocketUrl = session.stream?.websocketUrl;
  if (!websocketUrl) {
    const reason = "experimental streaming was selected without an app-only stream endpoint";
    tierState = "browser";
    statusBar.setTier("browser", reason);
    showBrowserCard(session, reason);
    return;
  }
  streamRoot.hidden = false;
  cover.hidden = false;
  coverTitle.textContent = "Starting streamed VS Code";
  message.textContent = "Launching a server-side browser for the genuine OpenVSCode workbench…";
  details.textContent = "Experimental mode: compressed pixels and user input are relayed over the MCP gateway.";
  let mounted = false;
  const viewer = new StreamedWorkbench(streamRoot, websocketUrl, {
    onStatus: (state, detail) => {
      if (viewer !== streamedWorkbench) return;
      if (state === "starting") message.textContent = detail ?? "Waiting for the genuine workbench…";
      else if (mounted && (state === "error" || state === "closed")) {
        failMountedStream(viewer, session, detail ?? `stream connection ${state}`);
        return;
      }
      statusBar.setConnection(state === "ready" ? "open" : state === "closed" || state === "error" ? "closed" : "connecting");
    },
  });
  streamedWorkbench = viewer;
  try {
    await viewer.mount();
    if (viewer !== streamedWorkbench || tierState !== "stream") return;
    mounted = true;
    cover.hidden = true;
  } catch (error) {
    if (viewer !== streamedWorkbench) return;
    viewer.dispose();
    streamedWorkbench = undefined;
    streamRoot.hidden = true;
    const reason = `experimental workbench streaming failed: ${describeError(error)}`;
    tierState = "browser";
    statusBar.setTier("browser", reason);
    showBrowserCard(session, reason);
  }
}

function failMountedStream(viewer: StreamedWorkbench, session: SessionPayload, detail: string): void {
  if (viewer !== streamedWorkbench || tierState !== "stream") return;
  viewer.dispose();
  streamedWorkbench = undefined;
  streamRoot.hidden = true;
  const reason = `experimental workbench streaming stopped: ${detail}`;
  tierState = "browser";
  statusBar.setConnection("closed");
  statusBar.setTier("browser", reason);
  showBrowserCard(session, reason);
}

function showBrowserCard(session: SessionPayload, reason: string): void {
  cover.hidden = false;
  coverTitle.textContent = "Real VS Code cannot be embedded here";
  const url = workbenchUrl(session);
  if (url) {
    message.textContent = "This host or deployment blocked the genuine workbench. No substitute editor has been loaded.";
    openBrowserLink.href = url;
    openBrowserLink.hidden = false;
    details.textContent = `${reason}\n${url}`;
  } else {
    message.textContent = "The genuine workbench does not have a browser-reachable URL.";
    openBrowserLink.hidden = true;
    details.textContent = reason;
  }
}

async function openInBrowser(): Promise<void> {
  const url = currentSession && workbenchUrl(currentSession);
  if (!url) return;
  try {
    if (app) await app.openLink({ url });
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    showTransientError(error);
  }
}

async function reloadCurrentTier(): Promise<void> {
  if (!currentSession) return;
  if (tierState === "embedded" && frame.src) {
    frame.src = frame.src;
    return;
  }
  await reprobeFromScratch(currentSession, "the user requested a reload");
}

async function reprobeFromScratch(session: SessionPayload, cause: string): Promise<void> {
  logTier(`re-probing the genuine workbench: ${cause}`);
  tierState = "probing";
  probeToken += 1;
  await runProbe(session);
}

function showError(summary: string, detail: string): void {
  cover.hidden = false;
  frame.hidden = true;
  streamRoot.hidden = true;
  streamedWorkbench?.dispose();
  streamedWorkbench = undefined;
  coverTitle.textContent = "VS Code unavailable";
  message.textContent = summary;
  details.textContent = detail;
  openBrowserLink.hidden = true;
  statusBar.setError(true);
}

function showTransientError(error: unknown): void {
  const previous = runtimeStatus.textContent;
  runtimeStatus.textContent = describeError(error);
  window.setTimeout(() => {
    runtimeStatus.textContent = currentSession?.openVscode?.state ?? previous;
  }, 3_000);
}

function workbenchUrl(session: SessionPayload): string | undefined {
  return session.ideUrl ?? session.openVscode?.browserUrl;
}

function logTier(text: string, level: "info" | "warning" | "error" = "info"): void {
  if (level === "error") console.error(`[mcp-vscode/renderer] ${text}`);
  else if (level === "warning") console.warn(`[mcp-vscode/renderer] ${text}`);
  else console.debug(`[mcp-vscode/renderer] ${text}`);
  app?.sendLog({ level, logger: "mcp-vscode/renderer", data: text }).catch(() => undefined);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logo(className: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.4 2.2 8.5 10.3 4.1 7 2 8.1v7.8L4.1 17l4.4-3.3 8.9 8.1 4.6-2.2V4.4l-4.6-2.2Zm-.7 5.5v8.6l-5.5-4.3 5.5-4.3ZM4.8 12l2.5-1.9v3.8L4.8 12Z"/></svg>`;
}
