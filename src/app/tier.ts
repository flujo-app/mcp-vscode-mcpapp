// Renderer selection (issue #7 / #10). Order of preference:
//   1. "native"   — Monaco + xterm rendered in this document, talking to the
//      gateway's authenticated `/ui` WebSocket + `/assets` static bundle.
//      Works in hosts that strip `frameDomains` (e.g. Claude Desktop today)
//      because it only needs `connectDomains` + `resourceDomains`.
//   2. "portable"  — the same Monaco + xterm shell, fully bundled into the
//      MCP App and backed by standard `ui/call-tool` requests. This tier has
//      no side HTTP/WebSocket listener and therefore works through any
//      conforming MCP Apps host.
//   3. "embedded"  — a legacy/debug iframe strategy: `frame.src = ideUrl`,
//      confirmed alive via the liveness handshake
//      (`src/http/inject.ts` / `mcp-vscode:workbench-alive`). A connected MCP
//      App prefers portable rather than trusting an advertised `/ide` URL.
//   4. "browser"   — no usable MCP Apps tool channel: render a
//      "open in your browser" affordance instead of leaving a blank frame.
//
// `selectTier` never returns without a decision; callers are expected to
// apply a hard watchdog on top (see `main.ts`) in case a probe hangs.

export type Tier = "probing" | "native" | "embedded" | "portable" | "browser";

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

export interface TierProbeOptions {
  nativeTimeoutMs?: number;
  embeddedTimeoutMs?: number;
  portableAvailable?: boolean;
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

/** Tier 1 probe: the private `/ui` socket must open. Monaco and xterm are
 * bundled into the MCP App itself, so no sidecar asset request is required. */
export async function probeNative(
  session: SessionPayload,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
): Promise<boolean> {
  if (!session.gatewayOrigin || !session.uiToken) return false;
  try {
    await probeSocket(uiSocketUrl(session.gatewayOrigin, session.uiToken), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function probeSocket(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    let opened = false;
    let settled = false;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      reject(error);
      return;
    }
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = window.setTimeout(() => {
      socket.close();
      finish(new Error("native /ui socket probe timed out"));
    }, timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        opened = true;
        // `/ui` permits one client. Wait for the probe connection's normal
        // close handshake before mounting UiTransport, otherwise the real
        // renderer can race the still-attached probe and be rejected as the
        // second client (4409).
        socket.close(1000, "native probe complete");
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (event) => {
        if (opened && event.code === 1000) finish();
        else finish(new Error(`native /ui socket probe closed before completion (${event.code})`));
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        finish(new Error("native /ui socket probe failed"));
      },
      { once: true },
    );
  });
}

/** Legacy iframe probe: point the (already-mounted) iframe at `ideUrl` and wait for
 * the liveness `postMessage`. Resolves `false` (never rejects) on timeout or
 * frame `error` so the caller can always fall through to the browser card. */
export function probeEmbedded(
  frame: HTMLIFrameElement,
  ideUrl: string,
  timeoutMs = DEFAULT_EMBEDDED_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: number | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.removeEventListener("error", onError);
      resolve(ok);
    };
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown } | undefined;
      if (data && typeof data === "object" && data.type === LIVENESS_MARKER) finish(true);
    };
    const onError = (): void => finish(false);
    try {
      timer = window.setTimeout(() => finish(false), timeoutMs);
      window.addEventListener("message", onMessage);
      frame.addEventListener("error", onError, { once: true });
      frame.src = ideUrl;
    } catch {
      // A hostile or incomplete host DOM can throw while listeners are being
      // registered or while the iframe URL is assigned. A probe must always
      // fail forward to the browser tier rather than reject and strand the UI.
      finish(false);
    }
  });
}

/** Runs the full probe chain and returns the tier that was committed to,
 * along with a short human-readable reason (surfaced in the status bar /
 * diagnostics, never silently discarded). */
export async function selectTier(
  session: SessionPayload,
  frame: HTMLIFrameElement,
  options: TierProbeOptions = {},
): Promise<TierProbeResult> {
  if (await probeNative(session, options.nativeTimeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS)) {
    return { tier: "native", reason: "the private /ui socket is reachable" };
  }
  if (options.portableAvailable) {
    return {
      tier: "portable",
      reason: "the private gateway is not reachable; using bundled Monaco over the MCP Apps tool channel",
    };
  }
  const ideUrl = session.ideUrl ?? session.openVscode?.browserUrl;
  if (ideUrl) {
    if (await probeEmbedded(frame, ideUrl, options.embeddedTimeoutMs ?? DEFAULT_EMBEDDED_TIMEOUT_MS)) {
      return { tier: "embedded", reason: "the embedded workbench frame confirmed it loaded" };
    }
    return {
      tier: "browser",
      reason: "the embedded workbench frame did not report loading (likely blocked by the host's frame policy)",
    };
  }
  return { tier: "browser", reason: "no workbench URL is available yet" };
}
