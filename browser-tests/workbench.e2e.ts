import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
let host: Server, hostPort: number;
test.beforeAll(async () => {
  const html = await readFile("dist/app.html", "utf8");
  host = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/workbench") {
      res.end(html);
      return;
    }
    const opaque = req.url?.includes("opaque=1");
    res.end(
      `<iframe title="MCP VS Code" sandbox="allow-scripts allow-downloads ${opaque ? "" : "allow-same-origin"}" style="width:1300px;height:900px"></iframe>`,
    );
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  hostPort = (host.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => host.close(() => resolve()));
});
const token = "vscode-browser-operator-token-00000000000000000";
async function tool(
  request: APIRequestContext,
  name: string,
  args: unknown = {},
) {
  const response = await request.post("http://127.0.0.1:33111/mcp", {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.error).toBeUndefined();
  return body.result;
}
test("standalone login keeps credentials out of URLs/storage and opens the real editor", async ({
  page,
  request,
}) => {
  await page.goto("/app");
  await page.getByLabel("Access token").fill("incorrect");
  await page.getByRole("button", { name: "Open workbench" }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to connect");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Open workbench" }).click();
  await expect(page.locator("#runtime-status")).toHaveText("ready");
  await expect(page.locator("#tier-badge")).toHaveText("Embedded");
  await expect(page.locator("#workbench")).toBeVisible();
  await expect(page.locator("#bridge-status")).toHaveText("connected", {
    timeout: 60000,
  });
  expect((await tool(request, "editor_state")).isError).not.toBe(true);
  const browserState = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
    url: location.href,
  }));
  expect(browserState.local).not.toContain(token);
  expect(browserState.session).not.toContain(token);
  expect(browserState.url).toBe("http://127.0.0.1:33111/app");
  await page.reload();
  await expect(page.getByLabel("Access token")).toBeVisible();
});
for (const opaque of [false, true])
  test(`${opaque ? "opaque MCP App offers a browser fallback" : "isolated MCP App embeds the real workbench"} with host-only MCP authorization`, async ({
    page,
    request,
  }) => {
    const methods: string[] = [];
    await page.exposeFunction(
      "hostTool",
      async (params: { name: string; arguments?: unknown }) =>
        tool(request, params.name, params.arguments),
    );
    await page.exposeFunction("recordHostMethod", (method: string) =>
      methods.push(method),
    );
    await page.goto(
      `http://127.0.0.1:${hostPort}/host?opaque=${opaque ? 1 : 0}`,
    );
    await page.evaluate((hostPort) => {
      const frame = document.querySelector("iframe")!;
      window.addEventListener("message", async (event) => {
        if (
          event.source !== frame.contentWindow ||
          event.data?.jsonrpc !== "2.0"
        )
          return;
        const msg = event.data;
        await (window as any).recordHostMethod(msg.method);
        if (msg.id === undefined) return;
        let result: unknown;
        if (msg.method === "ui/initialize")
          result = {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "Regression host", version: "1" },
            hostCapabilities: {
              serverTools: {},
              sandbox: {
                csp: {
                  frameDomains: ["http://127.0.0.1:33111"],
                  connectDomains: [
                    "http://127.0.0.1:33111",
                    "ws://127.0.0.1:33111",
                  ],
                },
              },
            },
            hostContext: {
              theme: "dark",
              displayMode: "inline",
              availableDisplayModes: ["inline", "fullscreen", "pip"],
            },
          };
        else if (msg.method === "tools/call")
          result = await (window as any).hostTool(msg.params);
        else result = {};
        frame.contentWindow!.postMessage(
          { jsonrpc: "2.0", id: msg.id, result },
          "*",
        );
      });
      frame.src = `http://localhost:${hostPort}/workbench`;
    }, hostPort);
    const app = page.frameLocator('iframe[title="MCP VS Code"]');
    if (opaque) {
      await expect(app.locator("#tier-badge")).toHaveText("Browser");
      await expect(app.locator("#details")).toContainText(
        "opaque sandbox origin",
      );
      await expect(app.locator("#workbench")).toBeHidden();
      await expect(app.locator("#open-browser")).toHaveAttribute(
        "href",
        /^http:\/\/127\.0\.0\.1:33111\/ide\//,
      );
    } else {
      await expect(app.locator("#tier-badge")).toHaveText("Embedded");
      await expect(app.locator("#workbench")).toBeVisible();
      await expect(app.locator("#bridge-status")).toHaveText("connected", {
        timeout: 60000,
      });
      const state = await tool(request, "editor_state");
      expect(state.isError).not.toBe(true);
    }
    expect(methods).toContain("ui/initialize");
    expect(methods).toContain("tools/call");
  });
