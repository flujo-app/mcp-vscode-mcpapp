import { build } from "esbuild";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const appTemplateWithStyles = appStyles
  ? appTemplate.replace("</head>", () => `<style>${appStyles}</style>\n  </head>`)
  : appTemplate;
const appHtml = appTemplateWithStyles.replace("/*__MCP_VSCODE_APP__*/", () => appScript);
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

await buildAssets(root, dist);

console.log("Built MCP server, MCP App view, and OpenVSCode bridge extension.");

/**
 * Emits `dist/app/assets/*`: the Phase 1 native-renderer bundle (Monaco +
 * xterm + `src/ui/index.ts`), Monaco's language workers as separate
 * cross-origin-loadable entry points, and a `manifest.json` mapping logical
 * names to their content-hashed filenames (workers and static assets are
 * hashed so `/assets`' cache-control logic can mark them `immutable`; the
 * manifest itself is not hashed, so the loader always finds it at a fixed
 * path).
 */
async function buildAssets(root, dist) {
  const assetsOutDir = path.join(dist, "app/assets");
  // Cleaned on every build so a renamed/removed hashed file from a previous
  // build never lingers and gets served stale.
  await rm(assetsOutDir, { recursive: true, force: true });
  await mkdir(assetsOutDir, { recursive: true });

  const workerModules = {
    "editor.worker": path.join(root, "node_modules/monaco-editor/esm/vs/editor/editor.worker.js"),
    "json.worker": path.join(root, "node_modules/monaco-editor/esm/vs/language/json/json.worker.js"),
    "css.worker": path.join(root, "node_modules/monaco-editor/esm/vs/language/css/css.worker.js"),
    "html.worker": path.join(root, "node_modules/monaco-editor/esm/vs/language/html/html.worker.js"),
    "ts.worker": path.join(root, "node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js"),
  };
  const entryPoints = { index: path.join(root, "src/ui/index.ts"), ...workerModules };
  const nameByEntryPath = new Map(
    Object.entries(entryPoints).map(([name, absolutePath]) => [
      path.relative(root, absolutePath).split(path.sep).join("/"),
      name,
    ]),
  );

  const assetsBuild = await build({
    entryPoints,
    outdir: assetsOutDir,
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
    sourcemap: true,
    entryNames: "[name]-[hash]",
    chunkNames: "chunk-[hash]",
    assetNames: "[name]-[hash]",
    target: "es2022",
    platform: "browser",
    metafile: true,
    logLevel: "warning",
  });

  const manifest = {};
  for (const [outputPath, meta] of Object.entries(assetsBuild.metafile.outputs)) {
    if (!meta.entryPoint) continue;
    const logicalName = nameByEntryPath.get(meta.entryPoint);
    if (!logicalName) continue;
    const key = logicalName === "index" ? "index.js" : `${logicalName}.js`;
    manifest[key] = path.basename(outputPath);
  }

  // Static, non-JS assets referenced by Monaco/xterm: copy under a
  // content-hashed name (matching the `/assets` cache-control convention) and
  // record the mapping.
  await copyHashed(
    path.join(root, "node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf"),
    assetsOutDir,
    "codicon.ttf",
    manifest,
  );
  await copyHashed(
    path.join(root, "node_modules/@xterm/xterm/css/xterm.css"),
    assetsOutDir,
    "xterm.css",
    manifest,
  );

  await writeFile(path.join(assetsOutDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyHashed(sourcePath, outDir, logicalName, manifest) {
  const data = await readFile(sourcePath);
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 8);
  const ext = path.extname(logicalName);
  const base = path.basename(logicalName, ext);
  const hashedName = `${base}-${hash}${ext}`;
  await writeFile(path.join(outDir, hashedName), data);
  manifest[logicalName] = hashedName;
}
