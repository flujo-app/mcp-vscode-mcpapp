// Three-tier renderer selection (issue #7 / #10). Order of preference:
//   1. "native"   — Monaco + xterm rendered in this document, talking to the
//      gateway's authenticated `/ui` WebSocket + `/assets` static bundle.
//      Works in hosts that strip `frameDomains` (e.g. Claude Desktop today)
//      because it only needs `connectDomains` + `resourceDomains`.
//   2. "embedded"  — the existing iframe strategy: `frame.src = ideUrl`,
//      confirmed alive via the liveness handshake
//      (`src/http/inject.ts` / `mcp-vscode:workbench-alive`) rather than the
//      ambiguous `load`/`error` events (a CSP-blocked frame fires neither).
//   3. "browser"   — no positive signal from either of the above: render a
//      "open in your browser" affordance instead of leaving a blank frame.
//
// `selectTier` never returns without a decision; callers are expected to
// apply a hard watchdog on top (see `main.ts`) in case a probe hangs.

export type Tier = "probing" | "native" | "embedded" | "browser";

export interface SessionPayload {
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

export interface TierProbeResult {
  tier: Tier;
  reason: string;
}

export const DEFAULT_NATIVE_TIMEOUT_MS = 5_000;
export const DEFAULT_EMBEDDED_TIMEOUT_MS = 6_000;
export const LIVENESS_MARKER = "mcp-vscode:workbench-alive";

/** Builds the `/ui` WebSocket URL (same origin/scheme as the gateway, `ws(s)`
 * instead of `http(s)`) with the bridge-token-derived `uiToken` as the query
 * parameter (browser `WebSocket` clients cannot set custom headers). */
export function uiSocketUrl(gatewayOrigin: string, uiToken: string): string {
  const url = new URL("/ui", gatewayOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", uiToken);
  return url.toString();
}

/** Tier 1 probe: the `/ui` socket must open, and the static asset manifest
 * (used to resolve Monaco/xterm's hashed bundle names) must be fetchable.
 * Both are required for the native renderer to actually mount. */
export async function probeNative(
  session: SessionPayload,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<boolean> {
  if (!session.gatewayOrigin || !session.uiToken || !session.assetsUrl) return false;
  try {
    await Promise.all([
      probeSocket(uiSocketUrl(session.gatewayOrigin, session.uiToken), timeoutMs),
      probeAssets(session.assetsUrl, timeoutMs),
    ]);
    return true;
  } catch {
    return false;
  }
}

function probeSocket(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new Error("native /ui socket probe timed out"));
    }, timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        window.clearTimeout(timer);
        socket.close();
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        window.clearTimeout(timer);
        reject(new Error("native /ui socket probe failed"));
      },
      { once: true },
    );
  });
}

async function probeAssets(assetsUrl: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${assetsUrl.replace(/\/$/, "")}/manifest.json`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`assets manifest fetch failed: HTTP ${response.status}`);
  } finally {
    window.clearTimeout(timer);
  }
}

/** Tier 2 probe: point the (already-mounted) iframe at `ideUrl` and wait for
 * the liveness `postMessage`. Resolves `false` (never rejects) on timeout or
 * frame `error` so the caller can always fall through to Tier 3. */
export function probeEmbedded(
  frame: HTMLIFrameElement,
  ideUrl: string,
  timeoutMs = DEFAULT_EMBEDDED_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(ok);
    };
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown } | undefined;
      if (data && typeof data === "object" && data.type === LIVENESS_MARKER) finish(true);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    window.addEventListener("message", onMessage);
    frame.addEventListener("error", () => finish(false), { once: true });
    frame.src = ideUrl;
  });
}

/** Runs the full probe chain and returns the tier that was committed to,
 * along with a short human-readable reason (surfaced in the status bar /
 * diagnostics, never silently discarded). */
export async function selectTier(
  session: SessionPayload,
  frame: HTMLIFrameElement,
): Promise<TierProbeResult> {
  if (await probeNative(session)) {
    return { tier: "native", reason: "the /ui socket and assets bundle are both reachable" };
  }
  const ideUrl = session.ideUrl ?? session.openVscode?.browserUrl;
  if (ideUrl) {
    if (await probeEmbedded(frame, ideUrl)) {
      return { tier: "embedded", reason: "the embedded workbench frame confirmed it loaded" };
    }
    return {
      tier: "browser",
      reason: "the embedded workbench frame did not report loading (likely blocked by the host's frame policy)",
    };
  }
  return { tier: "browser", reason: "no workbench URL is available yet" };
}
