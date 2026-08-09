import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dist = path.join(root, "dist");
await mkdir(dist, { recursive: true });
// Remove the retired facsimile-renderer asset tree from incremental builds.
await rm(path.join(dist, "app"), { recursive: true, force: true });

await build({
  entryPoints: [path.join(root, "src/cli.ts")],
  outfile: path.join(dist, "cli.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  packages: "bundle",
  external: ["node-pty"],
  banner: {
    js: `#!/usr/bin/env node
import { createRequire as __mcpVscodeCreateRequire } from "node:module";
const require = __mcpVscodeCreateRequire(import.meta.url);`,
  },
});

const cliSmoke = spawnSync(process.execPath, [path.join(dist, "cli.js"), "--help"], {
  encoding: "utf8",
});
if (cliSmoke.status !== 0 || !cliSmoke.stdout.includes("mcp-vscode [options]")) {
  throw new Error(`Built CLI smoke test failed:\n${cliSmoke.stderr || cliSmoke.stdout}`);
}

const appBuild = await build({
  entryPoints: [path.join(root, "src/app/main.ts")],
  outfile: path.join(dist, "app-inline.js"),
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  write: false,
  minify: true,
  loader: {
    ".ttf": "dataurl",
  },
});
const appTemplate = await readFile(path.join(root, "src/app/index.html"), "utf8");
const appScript = appBuild.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
if (!appScript) throw new Error("MCP App bundle produced no JavaScript");
const appStyles = appBuild.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
const appPayload = `${
  appStyles
    ? `const __mcpVscodeStyles=document.createElement("style");__mcpVscodeStyles.textContent=${JSON.stringify(appStyles)};document.head.appendChild(__mcpVscodeStyles);`
    : ""
}\n${appScript}`;
// The genuine-workbench shell is small enough to inline directly. Escape a
// closing script sequence defensively because the bundle is embedded inside
// the template's existing `<script>` element.
const appHtml = appTemplate.replace(
  "/*__MCP_VSCODE_APP__*/",
  () => appPayload.replace(/<\/script/gi, "<\\/script"),
);
if (appHtml.includes("/*__MCP_VSCODE_APP__*/")) {
  throw new Error("MCP App placeholder leaked into the production HTML");
}
const appHtmlBytes = Buffer.byteLength(appHtml);
const mcpAppResourceLimitBytes = 2 * 1024 * 1024;
if (appHtmlBytes > mcpAppResourceLimitBytes) {
  throw new Error(
    `MCP App HTML is ${appHtmlBytes} bytes, exceeding the ${mcpAppResourceLimitBytes}-byte host limit`,
  );
}
await writeFile(path.join(dist, "app.html"), appHtml);

const extensionDir = path.join(dist, "bridge-extension");
await mkdir(extensionDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src/bridge-extension/extension.ts")],
  outfile: path.join(extensionDir, "extension.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
});
await cp(
  path.join(root, "src/bridge-extension/package.json"),
  path.join(extensionDir, "package.json"),
);

console.log("Built MCP server, MCP App view, and OpenVSCode bridge extension.");
