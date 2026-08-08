// MCP App renderer entry point. Replaces the old single-strategy
// ("always assume the iframe worked") renderer with the three-tier probe
// from issue #7: native (Monaco/xterm over the gateway's `/ui` socket) ->
// embedded (iframe against the proxied OpenVSCode workbench, confirmed via a
// liveness handshake) -> browser (an explicit "open in your browser" card).
//
// "Never a blank frame": the loading cover is only ever hidden by a
// *positive* signal from a committed tier. A 20s global watchdog forces
// Tier 3 if the probe is still undecided by then, so there is no code path
// that can leave the user staring at a permanently blank/loading screen.
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { probeEmbedded, probeNative, uiSocketUrl, type SessionPayload, type Tier, type TierProbeResult } from "./tier.js";
import { UiTransport, type TransportStatus } from "./transport.js";
import { Explorer } from "./explorer.js";
import { NativeEditor, type ActiveEditorContext } from "./editor.js";
import { NativeTerminal } from "./terminal.js";
import { StatusBar } from "./statusbar.js";
import { createDebouncer } from "./debounce.js";
import type { HostTokenMap, ThemeMode } from "./theme.js";

declare global {
  interface Window {
    __MCP_VSCODE_DEBUG__?: SessionPayload;
  }
}

const PROBE_WATCHDOG_MS = 20_000;
const MODEL_CONTEXT_DEBOUNCE_MS = 500;
const SELECTED_TEXT_CAP = 2_000;

const root = document.querySelector<HTMLDivElement>("#app")!;
root.innerHTML = `
  <main class="shell">
    <header class="titlebar">
      ${logo("mark")}
      <span class="title">MCP VS Code</span>
      <span class="subtitle" id="workspace">Connecting to workspace…</span>
      <span class="spacer"></span>
      <button id="open-in-browser" type="button" title="Open in your browser" disabled>Open in browser</button>
      <button id="reload" type="button" title="Reload">Reload</button>
      <button id="fullscreen" type="button" title="Request fullscreen mode">Fullscreen</button>
    </header>
    <section class="content">
      <div class="native-shell" id="native-shell" hidden>
        <aside class="explorer" id="explorer"></aside>
        <div class="editor-area">
          <div class="tabs" id="tabs"></div>
          <div class="conflict-banner" id="conflict-banner" hidden></div>
          <div class="editor-container" id="editor-container"></div>
          <div class="terminal-panel" id="terminal-panel">
            <div class="terminal-panel-header">
              <span>Terminal</span>
              <button id="terminal-new" type="button" title="New terminal">New</button>
            </div>
            <div class="terminal-container" id="terminal-container"></div>
          </div>
        </div>
      </div>
      <iframe id="workbench" class="workbench-frame" hidden title="VS Code workbench" allow="clipboard-read; clipboard-write" referrerpolicy="no-referrer"></iframe>
      <div class="cover" id="cover">
        <div class="card">
          ${logo("large-mark")}
          <h1 id="cover-title">Preparing VS Code</h1>
          <p class="message" id="message">Starting the bundled Code OSS workbench and bridge…</p>
          <div class="details" id="details"></div>
          <a class="open-browser" id="open-browser" href="#" target="_blank" rel="noopener noreferrer" hidden>Open in your browser</a>
        </div>
      </div>
    </section>
    <footer class="statusbar" id="statusbar">
      <span class="status-item"><span class="dot"></span><span id="runtime-status">Starting</span></span>
      <span class="status-item tier-badge" id="tier-badge">Detecting…</span>
      <span class="status-item">MCP bridge: <span id="bridge-status">waiting</span></span>
      <span class="status-item right" id="origin"></span>
    </footer>
  </main>`;

const frame = document.querySelector<HTMLIFrameElement>("#workbench")!;
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
const tierBadgeEl = document.querySelector<HTMLElement>("#tier-badge")!;
const nativeShell = document.querySelector<HTMLDivElement>("#native-shell")!;
const explorerRoot = document.querySelector<HTMLElement>("#explorer")!;
const tabsBar = document.querySelector<HTMLElement>("#tabs")!;
const editorContainer = document.querySelector<HTMLElement>("#editor-container")!;
const terminalContainer = document.querySelector<HTMLElement>("#terminal-container")!;
const conflictBanner = document.querySelector<HTMLDivElement>("#conflict-banner")!;

const statusBar = new StatusBar(statusbar, tierBadgeEl, bridgeStatus);

let app: App | undefined;
let currentSession: SessionPayload | undefined;
let tierState: Tier = "probing";
let probeToken = 0;
let watchdogTimer: number | undefined;

let transport: UiTransport | undefined;
let explorer: Explorer | undefined;
let editor: NativeEditor | undefined;
let terminal: NativeTerminal | undefined;
let lastCommittedOrigin: string | undefined;
let lastHostContext: McpUiHostContext | undefined;

// Debounced (500ms trailing) `app.updateModelContext()` push (epic #10
// §7-A / Phase 3 §4.1). Deep-equal-deduped via `lastModelContextKey` so an
// unchanged context (e.g. repeated cursor blinks in the same spot) never
// re-sends. Cancelled in `tearDownCurrentTier()` -- every new surface this
// wave adds registers its teardown there (§6.6).
let lastModelContextKey: string | undefined;
const pushModelContext = createDebouncer(MODEL_CONTEXT_DEBOUNCE_MS, (context: ActiveEditorContext) => {
  if (!app || tierState !== "native") return;
  const key = JSON.stringify(context);
  if (key === lastModelContextKey) return;
  lastModelContextKey = key;
  const selectedText = context.selectedText.slice(0, SELECTED_TEXT_CAP);
  const location = context.selection ? `:${context.selection.startLine}:${context.selection.startColumn}` : "";
  const selectionNote = selectedText ? ` with ${selectedText.split("\n").length} line(s) selected` : "";
  void app
    .updateModelContext({
      content: [
        {
          type: "text",
          text: context.path
            ? `The user is viewing ${context.path}${location}${selectionNote}.`
            : "The user has no file open in the editor.",
        },
      ],
      structuredContent: {
        activeFile: context.path,
        selection: context.selection,
        selectedText,
        dirty: context.dirty,
        openFiles: context.openFiles,
      },
    })
    .catch((error) => {
      // A host that does not implement `ui/update-model-context` must not
      // break the editor -- swallow and log only.
      logTier(`app.updateModelContext failed (non-fatal): ${describeError(error)}`, "warning");
    });
});

document.querySelector<HTMLButtonElement>("#reload")!.onclick = () => void reloadCurrentTier();
document.querySelector<HTMLButtonElement>("#fullscreen")!.onclick = async () => {
  if (!app) return;
  try {
    await app.requestDisplayMode({ mode: "fullscreen" });
  } catch (error) {
    showTransientError(error);
  }
};
document.querySelector<HTMLButtonElement>("#terminal-new")!.onclick = () => void terminal?.createSession();
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
    { name: "MCP VS Code", version: "0.1.0" },
    { availableDisplayModes: ["inline", "fullscreen", "pip"] },
  );
  app.ontoolresult = (result) => {
    const payload = result.structuredContent as SessionPayload | undefined;
    if (payload?.openVscode || payload?.ideUrl) applySession(payload);
  };
  app.onhostcontextchanged = (context) => {
    document.documentElement.dataset.theme = context.theme ?? "dark";
    applyHostTheme(context);
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
    if (response.ok) applySession((await response.json()) as SessionPayload);
  } catch {
    // The static debug view retains its last known state.
  }
}

function applySession(session: SessionPayload): void {
  currentSession = session;
  const state = session.openVscode?.state ?? "unknown";
  workspaceLabel.textContent = session.workspaceRoot ?? "Workspace";
  runtimeStatus.textContent = state;
  origin.textContent = session.gatewayOrigin ?? "";
  statusBar.setError(state === "failed" || state === "unavailable");
  // The "Open in browser" affordance (epic #10 §7-A) must be visible and
  // usable in EVERY tier, not just the Tier 3 fallback card -- as soon as
  // any workbench URL is known, offer it via `app.openLink()`.
  openInBrowserButton.disabled = !(session.ideUrl ?? session.openVscode?.browserUrl);

  if (state === "unavailable" || state === "failed") {
    // The runtime itself never came up: there is nothing to probe yet, so
    // surface the runtime error directly rather than running a tier probe
    // that would only fail for an unrelated reason.
    showError("The bundled OpenVSCode runtime is unavailable.", session.openVscode?.error ?? "Unknown runtime error");
    return;
  }

  const originChanged = lastCommittedOrigin !== undefined && lastCommittedOrigin !== session.gatewayOrigin;
  if (tierState === "probing" && probeToken === 0) {
    void runProbe(session);
    return;
  }
  if (originChanged) {
    // Gateway restarted on a different ephemeral port: nothing we mounted is
    // valid any more (assets URL, /ui socket, iframe origin all changed).
    void reprobeFromScratch(session, "the gateway origin changed (likely a restart on a new ephemeral port)");
  }
}

/**
 * Re-implements `selectTier()`'s exact decision logic (`src/app/tier.ts`)
 * using its already-exported per-leg probes (`probeNative`/`probeEmbedded`)
 * instead of the composite function, purely so each leg's outcome can be
 * logged via `app.sendLog` (epic #10 §7-A acceptance criterion 7). Does
 * NOT modify `tier.ts` (out of this wave's scope) -- `selectTier()` itself
 * is left untouched and still exported/tested independently.
 */
async function runTierProbeWithLogging(session: SessionPayload, frame: HTMLIFrameElement): Promise<TierProbeResult> {
  logTier("tier probe starting: checking native tier (ui socket + assets bundle)");
  const nativeOk = await probeNative(session);
  logTier(`native leg result: ${nativeOk ? "reachable" : "not reachable"}`);
  if (nativeOk) {
    return { tier: "native", reason: "the /ui socket and assets bundle are both reachable" };
  }

  const ideUrl = session.ideUrl ?? session.openVscode?.browserUrl;
  if (ideUrl) {
    logTier(`embedded leg starting: probing the workbench iframe liveness handshake at ${ideUrl}`);
    const embeddedOk = await probeEmbedded(frame, ideUrl);
    logTier(`embedded leg result: ${embeddedOk ? "liveness handshake received" : "no liveness signal (likely blocked framing)"}`);
    if (embeddedOk) {
      return { tier: "embedded", reason: "the embedded workbench frame confirmed it loaded" };
    }
    return {
      tier: "browser",
      reason: "the embedded workbench frame did not report loading (likely blocked by the host's frame policy)",
    };
  }
  logTier("embedded leg skipped: no workbench URL is available yet");
  return { tier: "browser", reason: "no workbench URL is available yet" };
}

async function runProbe(session: SessionPayload): Promise<void> {
  const token = ++probeToken;
  tierState = "probing";
  statusBar.setTier("probing");
  message.textContent = "Detecting the best way to embed VS Code in this host…";
  details.textContent = "";
  openBrowserLink.hidden = true;
  coverTitle.textContent = "Preparing VS Code";
  cover.hidden = false;

  if (watchdogTimer !== undefined) window.clearTimeout(watchdogTimer);
  watchdogTimer = window.setTimeout(() => {
    if (token !== probeToken || tierState !== "probing") return;
    const reason = "tier probe watchdog (20s) fired before a tier could be committed";
    logTier(reason, "warning");
    commitTier({ tier: "browser", reason }, session);
  }, PROBE_WATCHDOG_MS);

  const result = await runTierProbeWithLogging(session, frame).catch((error): TierProbeResult => {
    const reason = `tier probe threw: ${describeError(error)}`;
    logTier(reason, "error");
    return { tier: "browser", reason };
  });
  if (token !== probeToken) return; // superseded by a newer probe
  commitTier(result, session);
}

function commitTier(result: TierProbeResult, session: SessionPayload): void {
  if (watchdogTimer !== undefined) window.clearTimeout(watchdogTimer);
  watchdogTimer = undefined;
  tierState = result.tier;
  lastCommittedOrigin = session.gatewayOrigin;
  logTier(`committing tier "${result.tier}" — ${result.reason}`);
  statusBar.setTier(result.tier, result.reason);
  tearDownCurrentTier(result.tier);

  if (result.tier === "native") {
    void mountNative(session);
  } else if (result.tier === "embedded") {
    nativeShell.hidden = true;
    frame.hidden = false;
    cover.hidden = true; // probeEmbedded already committed the frame src.
  } else {
    nativeShell.hidden = true;
    frame.hidden = true;
    showBrowserCard(session, result.reason);
  }
}

function tearDownCurrentTier(nextTier: Tier): void {
  if (nextTier !== "native") {
    transport?.close();
    transport = undefined;
    editor?.dispose();
    editor = undefined;
    terminal?.dispose();
    terminal = undefined;
    explorer = undefined;
    // Every native-only surface this wave added must be torn down here too
    // (§6.6): the debounced model-context push and its dedupe key.
    pushModelContext.cancel();
    lastModelContextKey = undefined;
  }
  if (nextTier !== "embedded") {
    frame.src = "about:blank";
  }
}

async function mountNative(session: SessionPayload): Promise<void> {
  if (!session.gatewayOrigin || !session.uiToken || !session.assetsUrl) {
    commitTier({ tier: "browser", reason: "native tier selected but the session payload is incomplete" }, session);
    return;
  }
  nativeShell.hidden = false;
  frame.hidden = true;
  cover.hidden = true;

  transport = new UiTransport(uiSocketUrl(session.gatewayOrigin, session.uiToken));
  transport.onStatusChange = (status: TransportStatus) => statusBar.setConnection(status);
  transport.onGiveUp = () => {
    // Three consecutive reconnect failures: assume the gateway restarted
    // (new ephemeral port) or the socket is durably blocked, and re-run the
    // full probe rather than spinning forever in a broken native tier.
    if (currentSession) {
      void reprobeFromScratch(
        currentSession,
        "the /ui transport gave up reconnecting after repeated consecutive failures",
      );
    }
  };
  transport.connect();

  explorer = new Explorer(explorerRoot, transport, {
    onOpenFile: (path) => void editor?.openFile(path),
  });
  editor = new NativeEditor(editorContainer, tabsBar, transport, session.assetsUrl, {
    onDirtyChanged: () => {
      /* tab dot rendering is handled inside NativeEditor itself */
    },
    onConflict: (path, expected, actual) => showConflictBanner(path, expected, actual),
    onError: (msg) => showTransientError(new Error(msg)),
    onActiveContextChanged: (context) => pushModelContext(context),
  });
  terminal = new NativeTerminal(terminalContainer, transport, session.assetsUrl, session.workspaceRoot ?? ".");

  // Register the server->client `/ui` RPC handlers for the five
  // `editor_*`/`diagnostics_get` MCP tools (epic #10 §7-A item 6 / Phase 3
  // §2.4): this is the client half of the bidirectional channel landed in
  // `src/http/ui-socket.ts`. Closures over `editor` are safe even though
  // it is reassigned just below -- no message can arrive before this
  // synchronous function returns control to the event loop.
  transport.handle("editor.open", (params) => requireEditor().open(params));
  transport.handle("editor.state", () => requireEditor().getState());
  transport.handle("editor.setSelection", (params) => requireEditor().setSelection(params));
  transport.handle("editor.applyEdits", (params) => requireEditor().applyEdits(params));
  transport.handle("diagnostics.get", (params) => requireEditor().getDiagnostics(params));

  try {
    await editor.mount();
    await terminal.mount();
    await explorer.refresh();
    if (lastHostContext) applyHostTheme(lastHostContext);
  } catch (error) {
    showTransientError(error);
  }
}

/** Narrow accessor used by the `/ui` handlers registered in `mountNative`
 * above; throws (surfaced to the MCP caller as `INTERNAL_ERROR`, not
 * silently swallowed) if a stale handler somehow fires after teardown. */
function requireEditor(): NativeEditor {
  if (!editor) throw new Error("The native editor is not mounted");
  return editor;
}

/** Maps the host's CSS custom-property tokens onto Monaco/xterm (plan
 * §4.2) and mirrors them onto the document root so the app's own chrome
 * (tabs, explorer, statusbar) matches too. Safe to call before the native
 * tier mounts -- `NativeEditor`/`NativeTerminal` no-op until `mount()`
 * resolves, and `main.ts` calls this again once native mounting finishes. */
function applyHostTheme(context: McpUiHostContext): void {
  lastHostContext = context;
  const mode: ThemeMode = context.theme === "light" ? "light" : "dark";
  const tokens = (context.styles ?? {}) as HostTokenMap;
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value === "string" && key.startsWith("--")) {
      document.documentElement.style.setProperty(key, value);
    }
  }
  editor?.applyTheme(tokens, mode);
  terminal?.applyTheme(tokens, mode);
}

function showConflictBanner(path: string, expected: string, actual: string): void {
  conflictBanner.hidden = false;
  conflictBanner.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = `"${path}" changed on disk since it was opened.`;
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload from disk (discard my changes)";
  reload.onclick = () => {
    void editor?.reloadFromDisk(path);
    conflictBanner.hidden = true;
  };
  const overwrite = document.createElement("button");
  overwrite.type = "button";
  overwrite.textContent = "Overwrite disk";
  overwrite.onclick = () => {
    void editor?.overwriteWithLocal(path, actual);
    conflictBanner.hidden = true;
  };
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.onclick = () => {
    conflictBanner.hidden = true;
  };
  void expected;
  conflictBanner.append(text, reload, overwrite, cancel);
}

function showBrowserCard(session: SessionPayload, reason: string): void {
  cover.hidden = false;
  coverTitle.textContent = "Open VS Code in your browser";
  const url = session.ideUrl ?? session.openVscode?.browserUrl;
  if (url) {
    message.textContent = "This host cannot embed the workbench directly, but it can still be reached in a regular browser tab.";
    openBrowserLink.href = url;
    openBrowserLink.hidden = false;
  } else {
    message.textContent = "The workbench is not reachable yet.";
    openBrowserLink.hidden = true;
  }
  details.textContent = reason;
}

/** Shared "Open in your browser" action for both the always-visible
 * titlebar button (all tiers, epic #10 §7-A item 3) and the Tier 3 card's
 * link. Prefers `app.openLink()` -- the host-sanctioned navigation bridge
 * -- and only falls back to a raw `window.open()` in the debug harness
 * (which has no `App` instance at all). */
async function openInBrowser(): Promise<void> {
  const url = currentSession?.ideUrl ?? currentSession?.openVscode?.browserUrl;
  if (!url) return;
  try {
    if (app) {
      await app.openLink({ url });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
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
  await reprobeFromScratch(currentSession, "user requested a reload");
}

async function reprobeFromScratch(session: SessionPayload, cause: string): Promise<void> {
  logTier(`re-probing from scratch: ${cause}`);
  tierState = "probing";
  probeToken += 1; // invalidate any in-flight probe from the previous origin
  await runProbe(session);
}

function showError(summary: string, detail: string): void {
  cover.hidden = false;
  coverTitle.textContent = "Preparing VS Code";
  message.textContent = summary;
  details.textContent = detail;
  openBrowserLink.hidden = true;
  statusBar.setError(true);
}

function showTransientError(error: unknown): void {
  const previous = runtimeStatus.textContent;
  runtimeStatus.textContent = error instanceof Error ? error.message : String(error);
  window.setTimeout(() => {
    runtimeStatus.textContent = currentSession?.openVscode?.state ?? previous;
  }, 3_000);
}

/** `app.sendLog` on every tier transition (epic #10 §7-A acceptance
 * criterion 7): probe start, each leg's outcome plus its reason string,
 * the commit, and any re-probe cause. Also logs to the console so the
 * same information is visible without a host that surfaces MCP logs.
 * Never throws -- a host without logging support must not break the
 * editor. */
function logTier(text: string, level: "info" | "warning" | "error" = "info"): void {
  if (level === "error") console.error(`[mcp-vscode/tier] ${text}`);
  else if (level === "warning") console.warn(`[mcp-vscode/tier] ${text}`);
  else console.debug(`[mcp-vscode/tier] ${text}`);
  if (!app) return;
  app.sendLog({ level, logger: "mcp-vscode/tier", data: text }).catch(() => {
    // Best-effort: some hosts may not implement server-side logging.
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logo(className: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.4 2.2 8.5 10.3 4.1 7 2 8.1v7.8L4.1 17l4.4-3.3 8.9 8.1 4.6-2.2V4.4l-4.6-2.2Zm-.7 5.5v8.6l-5.5-4.3 5.5-4.3ZM4.8 12l2.5-1.9v3.8L4.8 12Z"/></svg>`;
}
