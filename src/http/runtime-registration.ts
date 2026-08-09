import { createHmac } from "node:crypto";

export const FLUJO_RUNTIME_REGISTER_URL_ENV = "FLUJO_MCP_APP_RUNTIME_REGISTER_URL";
export const FLUJO_RUNTIME_REGISTER_TOKEN_ENV = "FLUJO_MCP_APP_RUNTIME_REGISTER_TOKEN";
export const FLUJO_RUNTIME_REGISTER_PATH = "/_flujo/runtime/register";
export const FLUJO_RUNTIME_PROOF_PATH = "/.well-known/flujo/mcp-app-runtime";
export const FLUJO_RUNTIME_PROOF_CHALLENGE_HEADER = "x-flujo-runtime-challenge";
export const FLUJO_RUNTIME_PROOF_HEADER = "x-flujo-runtime-proof";

const PROOF_MESSAGE_PREFIX = "flujo-mcp-app-runtime-proof-v1:";
const REGISTRATION_TIMEOUT_MS = 30_000;
// FLUJO's target-control probe has its own 5s timeout. Give the broker enough
// time to finish that probe and send an authoritative response; aborting first
// creates an indeterminate one-use POST that is not safe to replay.
const REGISTRATION_ATTEMPT_TIMEOUT_MS = 7_500;
const REGISTRATION_RETRY_DELAY_MS = 250;
// FLUJO reserves 503 for registration prerequisites that failed before the
// capability is consumed (for example, its public App origin is not ready).
// No other HTTP failure is safe to replay: it may have been produced after the
// route was installed and the single-use bearer was deleted.
const RETRYABLE_BROKER_STATUSES = new Set([503]);
const SAFE_PRECONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface RuntimeBrokerRoute {
  path: string;
  match: "exact" | "prefix";
  httpMethods?: string[];
  websocket?: boolean;
}

export interface RuntimeBrokerRegistration {
  registerUrl: string;
  token: string;
}

export interface RuntimeBrokerRegistrationResult {
  originKey: string;
  publicOrigin: string;
}

/**
 * Read the short-lived capability FLUJO gives one managed stdio child. Both
 * values are required together; silently accepting half a capability would
 * make a hosted deployment advertise an unreachable loopback URL.
 */
export function runtimeBrokerRegistrationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeBrokerRegistration | undefined {
  const registerUrl = env[FLUJO_RUNTIME_REGISTER_URL_ENV]?.trim();
  const token = env[FLUJO_RUNTIME_REGISTER_TOKEN_ENV]?.trim();
  if (!registerUrl && !token) return undefined;
  if (!registerUrl || !token) {
    throw new Error(
      `${FLUJO_RUNTIME_REGISTER_URL_ENV} and ${FLUJO_RUNTIME_REGISTER_TOKEN_ENV} must be set together`,
    );
  }
  return validateRuntimeBrokerRegistration({ registerUrl, token });
}

function validateRuntimeBrokerRegistration(
  registration: RuntimeBrokerRegistration,
): RuntimeBrokerRegistration {
  const { registerUrl, token } = registration;
  const parsed = new URL(registerUrl);
  if (
    parsed.protocol !== "http:"
    || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
    || !parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== FLUJO_RUNTIME_REGISTER_PATH
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      `${FLUJO_RUNTIME_REGISTER_URL_ENV} must be ${FLUJO_RUNTIME_REGISTER_PATH} on an explicit loopback HTTP port`,
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error(`${FLUJO_RUNTIME_REGISTER_TOKEN_ENV} is malformed`);
  }
  return { registerUrl: parsed.toString(), token };
}

/** Answer FLUJO's chosen-message proof without exposing the bearer itself. */
export function runtimeBrokerProof(token: string, challenge: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("The runtime proof token is malformed");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new Error("The runtime proof challenge is malformed");
  }
  return createHmac("sha256", token)
    .update(`${PROOF_MESSAGE_PREFIX}${challenge}`, "utf8")
    .digest("base64url");
}

/**
 * Register a loopback gateway and its explicit browser-facing route manifest.
 * FLUJO independently validates the target, resource identity, methods, and
 * paths before returning the per-App public origin.
 */
export async function registerRuntimeWithBroker(options: {
  broker: RuntimeBrokerRegistration;
  resourceUri: string;
  targetOrigin: string;
  routes: RuntimeBrokerRoute[];
  timeoutMs?: number;
}): Promise<RuntimeBrokerRegistrationResult> {
  // Callers normally obtain this through runtimeBrokerRegistrationFromEnv(),
  // but validate again at the side-effect boundary so a programmatic Gateway
  // cannot send FLUJO's bearer to an arbitrary URL.
  const broker = validateRuntimeBrokerRegistration(options.broker);
  const target = new URL(options.targetOrigin);
  if (
    target.protocol !== "http:"
    || (target.hostname !== "127.0.0.1" && target.hostname !== "[::1]")
    || !target.port
    || target.username
    || target.password
    || target.pathname !== "/"
    || target.search
    || target.hash
  ) {
    throw new Error("The MCP App runtime broker target must be an HTTP loopback origin");
  }

  const requestBody = JSON.stringify({
    version: 1,
    resourceUri: options.resourceUri,
    targetOrigin: target.origin,
    routes: options.routes,
  });
  const deadline = Date.now() + (options.timeoutMs ?? REGISTRATION_TIMEOUT_MS);
  let lastError = "the broker was not ready";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let responseStatus: number | undefined;
    try {
      const response = await fetch(broker.registerUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${broker.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: requestBody,
        signal: AbortSignal.timeout(Math.max(1, Math.min(REGISTRATION_ATTEMPT_TIMEOUT_MS, remaining))),
      });
      responseStatus = response.status;
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (!RETRYABLE_BROKER_STATUSES.has(response.status)) {
          throw new DefinitiveRegistrationError(
            `broker response ${response.status} could not be read; the one-use capability may have been consumed (${describeError(error)})`,
          );
        }
        lastError = `broker returned ${response.status}, but its response body could not be read: ${describeError(error)}`;
        text = "";
      }
      const body = parseJson(text);
      if (response.ok) return parseRegistrationResponse(body);

      const detail = isRecord(body) && typeof body.error === "string" ? body.error : text || response.statusText;
      lastError = `broker returned ${response.status}: ${detail}`;
      // Only statuses that are guaranteed to precede registration are safe to
      // retry with a single-use bearer. An arbitrary 5xx can be emitted after
      // state mutation, so fail closed unless the status is explicitly known
      // to represent a transient pre-registration condition.
      if (!RETRYABLE_BROKER_STATUSES.has(response.status)) {
        throw new DefinitiveRegistrationError(lastError);
      }
    } catch (error) {
      if (error instanceof DefinitiveRegistrationError) throw new Error(`FLUJO MCP App runtime registration failed: ${error.message}`);
      if (responseStatus !== undefined && RETRYABLE_BROKER_STATUSES.has(responseStatus)) {
        lastError = `broker returned ${responseStatus}: ${describeError(error)}`;
      } else if (!isSafePreconnectFailure(error)) {
        throw new Error(
          `FLUJO MCP App runtime registration outcome is indeterminate; refusing to replay the one-use capability: ${describeError(error)}`,
        );
      } else {
        lastError = describeError(error);
      }
    }
    const delayMs = Math.min(REGISTRATION_RETRY_DELAY_MS, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await delay(delayMs);
  }
  throw new Error(`FLUJO MCP App runtime registration did not become ready: ${lastError}`);
}

/** Remove the one-use capability before any OpenVSCode/extension child starts. */
export function clearRuntimeBrokerEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  delete env[FLUJO_RUNTIME_REGISTER_URL_ENV];
  delete env[FLUJO_RUNTIME_REGISTER_TOKEN_ENV];
}

function exactHttpOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("FLUJO MCP App runtime registration returned a non-origin public URL");
  }
  return parsed.origin;
}

function parseRegistrationResponse(body: unknown): RuntimeBrokerRegistrationResult {
  if (!isRecord(body) || body.version !== 1 || typeof body.originKey !== "string" || typeof body.publicOrigin !== "string") {
    throw new DefinitiveRegistrationError("the broker returned an invalid success response");
  }
  let publicOrigin: string;
  try {
    publicOrigin = exactHttpOrigin(body.publicOrigin);
  } catch (error) {
    throw new DefinitiveRegistrationError(`the broker returned an invalid public origin: ${describeError(error)}`);
  }
  if (!/^app[a-f0-9]{60}$/.test(body.originKey)) {
    throw new DefinitiveRegistrationError("the broker returned an invalid App origin key");
  }
  const publicHostname = new URL(publicOrigin).hostname.toLowerCase();
  if (!publicHostname.split(".").includes(body.originKey)) {
    throw new DefinitiveRegistrationError("the broker public origin is not scoped to its App origin key");
  }
  return { originKey: body.originKey, publicOrigin };
}

function parseJson(value: string): unknown {
  try {
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

class DefinitiveRegistrationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Retry only failures that prove no HTTP connection reached the broker. Socket
 * resets, aborts, and body failures are intentionally excluded: the broker may
 * already have registered the route and consumed the bearer before they occur.
 */
function isSafePreconnectFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof record.code === "string" && SAFE_PRECONNECT_ERROR_CODES.has(record.code)) return true;
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return record.errors.every((candidate) => isSafePreconnectFailure(candidate));
  }
  return record.cause !== undefined && isSafePreconnectFailure(record.cause);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
