// Honest renderer selection. The product is a real OpenVSCode workbench, so
// the UI either embeds that workbench or explains why it cannot. A Monaco /
// xterm facsimile is deliberately not a fallback: silently swapping products
// made host-policy and deployment failures look like success.
//
//   1. "stream"   — explicit experimental mode: genuine OpenVSCode rendered
//      by server-side Chromium and delivered as pixels over an authenticated
//      connection. Never selected unless the server opted in.
//   2. "embedded" — the genuine OpenVSCode workbench, confirmed alive via the
//      liveness handshake (`src/http/inject.ts`).
//   3. "browser"  — an explicit host-policy/network fallback that opens the
//      same genuine workbench in a regular browser tab.
//
// `selectTier` never returns without a decision; callers are expected to
// apply a hard watchdog on top (see `main.ts`) in case a probe hangs.

import {
  WORKBENCH_IDE_META_KEY,
  WORKBENCH_STREAM_META_KEY,
  type WorkbenchIdeResultMeta,
  type WorkbenchStreamResultMeta,
  type WorkbenchStreamStatus,
} from "../stream/protocol.js";

export type Tier = "probing" | "stream" | "embedded" | "browser";
export type FramePolicy = "allowed" | "denied" | "unknown";

export interface SessionPayload {
  workspaceRoot?: string;
  ideUrl?: string;
  gatewayOrigin?: string;
  stream?: WorkbenchStreamStatus;
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
  embeddedTimeoutMs?: number;
  /** Result of comparing the workbench origin with the host-approved CSP. */
  framePolicy?: FramePolicy;
}

/** Merge capability URLs from App-only tool-result metadata into the public
 * session shape. Neither URL is present in model-visible structured content. */
export function sessionWithAppMeta(
  payload: SessionPayload | undefined,
  meta: Record<string, unknown> | undefined,
): SessionPayload | undefined {
  if (!payload) return undefined;
  const ideMeta = meta?.[WORKBENCH_IDE_META_KEY] as WorkbenchIdeResultMeta | undefined;
  const streamMeta = meta?.[WORKBENCH_STREAM_META_KEY] as WorkbenchStreamResultMeta | undefined;
  return {
    ...payload,
    ...(ideMeta?.ideUrl ? { ideUrl: ideMeta.ideUrl } : {}),
    ...(streamMeta?.websocketUrl && payload.stream
      ? { stream: { ...payload.stream, websocketUrl: streamMeta.websocketUrl } }
      : {}),
  };
}

export const DEFAULT_EMBEDDED_TIMEOUT_MS = 6_000;
export const LIVENESS_MARKER = "mcp-vscode:workbench-alive";

/** Genuine-workbench probe: point the iframe at `ideUrl` and wait for
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
      // Do not let an unrelated frame/window spoof the positive commit signal.
      // Some test/minimal DOMs do not expose contentWindow, hence the guarded
      // comparison rather than an unconditional one.
      if (frame.contentWindow && event.source !== frame.contentWindow) return;
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
  if (session.stream?.enabled) {
    if (session.stream.websocketUrl
      && session.stream.state !== "unavailable"
      && session.stream.state !== "failed"
      && session.stream.state !== "stopped") {
      return {
        tier: "stream",
        reason: "experimental genuine-workbench pixel streaming was explicitly enabled",
      };
    }
    return {
      tier: "browser",
      reason: session.stream.error
        ? `experimental workbench streaming is unavailable: ${session.stream.error}`
        : "experimental workbench streaming is enabled but no app-only stream endpoint was provided",
    };
  }
  const ideUrl = session.ideUrl ?? session.openVscode?.browserUrl;
  if (ideUrl) {
    if (options.framePolicy === "denied") {
      return {
        tier: "browser",
        reason: "the host did not approve the workbench origin in frameDomains",
      };
    }
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

/**
 * Compare a workbench URL with the CSP grant returned by `ui/initialize`.
 * `undefined` means the host did not report sandbox CSP capabilities, so the
 * caller should probe rather than assuming either success or denial.
 */
export function framePolicyForUrl(
  workbenchUrl: string,
  approvedFrameDomains: readonly string[] | undefined,
  hostReportedSandboxCsp: boolean,
): FramePolicy {
  if (!hostReportedSandboxCsp) return "unknown";
  let target: URL;
  try {
    target = new URL(workbenchUrl);
  } catch {
    return "denied";
  }
  for (const candidate of approvedFrameDomains ?? []) {
    if (candidate === "*") return "allowed";
    // CSP host-source PORT wildcard, e.g. `http://127.0.0.1:*`. Hosts such as
    // FLUJO canonicalize loopback grants to this form so a gateway's
    // ephemeral-port restart cannot invalidate an already-committed policy.
    // `new URL()` throws on `:*`, so the exact-origin branch below can never
    // recognize it — match scheme + host explicitly and accept any port.
    const portWildcard = /^([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/:?#]+):\*$/i.exec(candidate);
    if (portWildcard) {
      const scheme = portWildcard[1];
      const hostname = portWildcard[2];
      if (
        scheme !== undefined
        && hostname !== undefined
        && `${scheme.toLowerCase()}:` === target.protocol
        && hostname.toLowerCase() === target.hostname.toLowerCase()
      ) {
        return "allowed";
      }
      continue;
    }
    if (candidate.startsWith(`${target.protocol}//*.`)) {
      const suffix = candidate.slice(`${target.protocol}//*.`.length).replace(/\/$/, "");
      const hostWithPort = target.port ? `${target.hostname}:${target.port}` : target.hostname;
      if (hostWithPort.endsWith(`.${suffix}`)) return "allowed";
      continue;
    }
    try {
      if (new URL(candidate).origin === target.origin) return "allowed";
    } catch {
      // Ignore malformed values rather than widening a security decision.
    }
  }
  return "denied";
}
