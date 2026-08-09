import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VscodeCore } from "../src/core/core.js";
import { Gateway } from "../src/http/gateway.js";
import {
  FLUJO_RUNTIME_PROOF_CHALLENGE_HEADER,
  FLUJO_RUNTIME_PROOF_HEADER,
  FLUJO_RUNTIME_PROOF_PATH,
} from "../src/http/runtime-registration.js";
import type { OpenVscodeRuntime } from "../src/runtime/openvscode.js";

test("Gateway proves loopback control and adopts FLUJO's per-App public origin", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-vscode-runtime-broker-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const core = new VscodeCore(workspace);
  await core.initialize();
  t.after(() => core.close());

  const token = "r".repeat(43);
  const challenge = "c".repeat(43);
  let registrationBody: Record<string, unknown> | undefined;
  const broker = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        registrationBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const targetOrigin = String(registrationBody.targetOrigin);
        const proofResponse = await fetch(`${targetOrigin}${FLUJO_RUNTIME_PROOF_PATH}`, {
          headers: { [FLUJO_RUNTIME_PROOF_CHALLENGE_HEADER]: challenge },
        });
        assert.equal(proofResponse.status, 204);
        const expectedProof = createHmac("sha256", token)
          .update(`flujo-mcp-app-runtime-proof-v1:${challenge}`)
          .digest("base64url");
        assert.equal(proofResponse.headers.get(FLUJO_RUNTIME_PROOF_HEADER), expectedProof);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          version: 1,
          originKey: `app${"a".repeat(60)}`,
          publicOrigin: `https://app${"a".repeat(60)}.mcp-apps.example.test`,
        }));
      })().catch((error) => {
        response.writeHead(500).end(String(error));
      });
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  const brokerPort = (broker.address() as AddressInfo).port;

  const runtime = {
    basePath: `/ide/${"b".repeat(32)}`,
    target: undefined,
    status: () => ({ state: "starting", logs: [] }),
  } as unknown as OpenVscodeRuntime;
  const gateway = new Gateway({
    core,
    runtime,
    host: "127.0.0.1",
    port: 0,
    appHtmlPath: path.resolve("src/app/index.html"),
    stream: { enabled: true },
    runtimeBroker: {
      registration: {
        registerUrl: `http://127.0.0.1:${brokerPort}/_flujo/runtime/register`,
        token,
      },
      resourceUri: "ui://mcp-vscode/workbench.html",
    },
  });
  t.after(() => gateway.close());

  const address = await gateway.start();
  assert.equal(address.origin, `https://app${"a".repeat(60)}.mcp-apps.example.test`);
  assert.equal(gateway.origin, address.origin);
  assert.equal(registrationBody?.version, 1);
  assert.equal(registrationBody?.resourceUri, "ui://mcp-vscode/workbench.html");
  assert.match(String(registrationBody?.targetOrigin), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(registrationBody?.routes, [
    {
      path: `/ide/${"b".repeat(32)}`,
      match: "prefix",
      httpMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      websocket: true,
    },
    { path: "/stream", match: "exact", websocket: true },
  ]);

  // The proof oracle exists only during registration.
  const proofAfterRegistration = await fetch(
    `http://127.0.0.1:${address.port}${FLUJO_RUNTIME_PROOF_PATH}`,
    { headers: { [FLUJO_RUNTIME_PROOF_CHALLENGE_HEADER]: challenge } },
  );
  assert.equal(proofAfterRegistration.status, 404);
});
