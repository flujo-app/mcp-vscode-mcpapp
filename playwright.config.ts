import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "*.e2e.ts",
  workers: 1,
  timeout: 90000,
  expect: { timeout: 30000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:33111",
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
  webServer: {
    command:
      "node dist/cli.js --http --port 33111 --workspace .test-browser/workspace --state-dir .test-browser/state --openvscode-root runtime/openvscode-server",
    url: "http://127.0.0.1:33111/healthz",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      MCP_VSCODE_AUTH_TOKEN: "vscode-browser-operator-token-00000000000000000",
    },
  },
});
