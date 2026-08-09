import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  clearRuntimeBrokerEnvironment,
  FLUJO_RUNTIME_REGISTER_TOKEN_ENV,
  FLUJO_RUNTIME_REGISTER_URL_ENV,
  registerRuntimeWithBroker,
  runtimeBrokerProof,
  runtimeBrokerRegistrationFromEnv,
} from "../src/http/runtime-registration.js";

test("runtime broker environment is all-or-nothing and loopback-only", () => {
  assert.equal(runtimeBrokerRegistrationFromEnv({}), undefined);
  assert.throws(
    () => runtimeBrokerRegistrationFromEnv({ [FLUJO_RUNTIME_REGISTER_URL_ENV]: "http://127.0.0.1:4201/register" }),
    /must be set together/,
  );
  assert.throws(
    () => runtimeBrokerRegistrationFromEnv({
      [FLUJO_RUNTIME_REGISTER_URL_ENV]: "https://broker.example.test/register",
      [FLUJO_RUNTIME_REGISTER_TOKEN_ENV]: "a".repeat(43),
    }),
    /loopback/,
  );
  assert.throws(
    () => runtimeBrokerRegistrationFromEnv({
      [FLUJO_RUNTIME_REGISTER_URL_ENV]: "http://127.0.0.1:4201/not-the-registration-route",
      [FLUJO_RUNTIME_REGISTER_TOKEN_ENV]: "a".repeat(43),
    }),
    /_flujo\/runtime\/register/,
  );
});

test("runtime proof matches FLUJO's versioned HMAC contract", () => {
  const token = "t".repeat(43);
  const challenge = "c".repeat(43);
  const expected = createHmac("sha256", token)
    .update(`flujo-mcp-app-runtime-proof-v1:${challenge}`, "utf8")
    .digest("base64url");
  assert.equal(runtimeBrokerProof(token, challenge), expected);
  assert.throws(() => runtimeBrokerProof(token, "not a challenge!"), /malformed/);
});

test("registration sends only the declared target and route manifest", async (t) => {
  let receivedAuthorization = "";
  let receivedBody: unknown;
  const originKey = `app${"a".repeat(60)}`;
  const broker = http.createServer((request, response) => {
    receivedAuthorization = request.headers.authorization ?? "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        version: 1,
        originKey,
        publicOrigin: `https://${originKey}.example.test`,
      }));
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  const port = (broker.address() as AddressInfo).port;
  const token = "s".repeat(43);

  const result = await registerRuntimeWithBroker({
    broker: { registerUrl: `http://127.0.0.1:${port}/_flujo/runtime/register`, token },
    resourceUri: "ui://mcp-vscode/workbench.html",
    targetOrigin: "http://127.0.0.1:43123",
    routes: [
      {
        path: `/ide/${"b".repeat(32)}`,
        match: "prefix",
        httpMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        websocket: true,
      },
      { path: "/stream", match: "exact", websocket: true },
    ],
  });

  assert.deepEqual(result, {
    originKey,
    publicOrigin: `https://${originKey}.example.test`,
  });
  assert.equal(receivedAuthorization, `Bearer ${token}`);
  assert.deepEqual(receivedBody, {
    version: 1,
    resourceUri: "ui://mcp-vscode/workbench.html",
    targetOrigin: "http://127.0.0.1:43123",
    routes: [
      {
        path: `/ide/${"b".repeat(32)}`,
        match: "prefix",
        httpMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        websocket: true,
      },
      { path: "/stream", match: "exact", websocket: true },
    ],
  });
});

test("registration retries a transient 503 and then succeeds", async (t) => {
  let attempts = 0;
  const originKey = `app${"c".repeat(60)}`;
  const broker = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
        response.end(JSON.stringify({ error: "sandbox_listener_starting" }));
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        version: 1,
        originKey,
        publicOrigin: `https://${originKey}.example.test`,
      }));
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  const port = (broker.address() as AddressInfo).port;

  const result = await registerRuntimeWithBroker({
    broker: {
      registerUrl: `http://127.0.0.1:${port}/_flujo/runtime/register`,
      token: "r".repeat(43),
    },
    resourceUri: "ui://mcp-vscode/workbench.html",
    targetOrigin: "http://127.0.0.1:43123",
    routes: [{ path: `/ide/${"d".repeat(32)}`, match: "prefix", httpMethods: ["GET"] }],
    timeoutMs: 3_000,
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, {
    originKey,
    publicOrigin: `https://${originKey}.example.test`,
  });
});

test("registration does not replay a one-use capability after a 500", async (t) => {
  let attempts = 0;
  const broker = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      attempts += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "runtime_registration_failed" }));
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  const port = (broker.address() as AddressInfo).port;

  await assert.rejects(
    registerRuntimeWithBroker({
      broker: {
        registerUrl: `http://127.0.0.1:${port}/_flujo/runtime/register`,
        token: "q".repeat(43),
      },
      resourceUri: "ui://mcp-vscode/workbench.html",
      targetOrigin: "http://127.0.0.1:43123",
      routes: [{ path: `/ide/${"e".repeat(32)}`, match: "prefix", httpMethods: ["GET"] }],
      timeoutMs: 3_000,
    }),
    /registration failed: broker returned 500: runtime_registration_failed/,
  );
  assert.equal(attempts, 1);
});

test("one-use registration credentials can be scrubbed before child processes start", () => {
  const env: NodeJS.ProcessEnv = {
    KEEP_ME: "yes",
    [FLUJO_RUNTIME_REGISTER_URL_ENV]: "http://127.0.0.1:4201/_flujo/runtime/register",
    [FLUJO_RUNTIME_REGISTER_TOKEN_ENV]: "x".repeat(43),
  };
  clearRuntimeBrokerEnvironment(env);
  assert.deepEqual(env, { KEEP_ME: "yes" });
});
