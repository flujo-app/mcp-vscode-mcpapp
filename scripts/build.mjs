import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const dist = path.join(root, "dist");
await mkdir(dist, { recursive: true });

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
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  write: false,
  minify: true,
});
const appTemplate = await readFile(path.join(root, "src/app/index.html"), "utf8");
const appScript = appBuild.outputFiles[0]?.text;
if (!appScript) throw new Error("MCP App bundle produced no JavaScript");
const appHtml = appTemplate.replace("/*__MCP_VSCODE_APP__*/", () => appScript);
if (appHtml.includes("/*__MCP_VSCODE_APP__*/")) {
  throw new Error("MCP App placeholder leaked into the production HTML");
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
