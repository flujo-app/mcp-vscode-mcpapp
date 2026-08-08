// Minimal renderer entry for the `dist/app/assets` bundle. This is Phase 1
// plumbing only: it proves the build pipeline, cross-origin worker shim, and
// `/assets` route end-to-end. The real native (Monaco + xterm) renderer that
// consumes this bundle is Phase 2 (issue #7); nothing here is wired into
// `src/app/main.ts` yet.
import * as monaco from "monaco-editor/editor/editor.api.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

const WORKER_ENTRY_BY_LABEL: Record<string, string> = {
  json: "json.worker.js",
  css: "css.worker.js",
  scss: "css.worker.js",
  less: "css.worker.js",
  html: "html.worker.js",
  handlebars: "html.worker.js",
  razor: "html.worker.js",
  typescript: "ts.worker.js",
  javascript: "ts.worker.js",
};

/** Keyed by the manifest's logical asset name (`manifest.json`, emitted by
 * `scripts/build.mjs`), mapping to the actual content-hashed filename. */
type AssetManifest = Record<string, string>;

let manifestPromise: Promise<AssetManifest> | undefined;

function loadManifest(assetsUrl: string): Promise<AssetManifest> {
  manifestPromise ??= fetch(`${assetsUrl.replace(/\/$/, "")}/manifest.json`)
    .then((response) => response.json() as Promise<AssetManifest>);
  return manifestPromise;
}

/**
 * Monaco language workers are same-origin `new Worker(url)` by default, but
 * the MCP-app document and the gateway are different origins (opaque sandbox
 * vs. loopback:PORT). The standard cross-origin worker pattern is a `blob:`
 * URL whose body simply re-imports the real worker module from the gateway's
 * `/assets` origin (verified permitted: Claude Desktop's `resourceDomains`
 * covers script/connect-src for our origin, and constructing a `blob:`
 * Worker itself needs no additional permission).
 *
 * `assetsUrl` must come from the MCP session payload (`assetsUrl` field of
 * `sessionPayload()` in src/mcp/server.ts) at runtime -- never hardcoded,
 * since the gateway's loopback port is ephemeral.
 */
export async function installMonacoEnvironment(assetsUrl: string): Promise<void> {
  const base = assetsUrl.replace(/\/$/, "");
  const manifest = await loadManifest(assetsUrl);
  window.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string): Worker {
      const logicalName = WORKER_ENTRY_BY_LABEL[label] ?? "editor.worker.js";
      const hashedName = manifest[logicalName] ?? manifest["editor.worker.js"] ?? logicalName;
      const workerModuleUrl = `${base}/${hashedName}`;
      const blob = new Blob([`import ${JSON.stringify(workerModuleUrl)};`], { type: "text/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      return new Worker(blobUrl, { type: "module" });
    },
  };
}

export function createEditor(
  container: HTMLElement,
  options: { value?: string; language?: string } = {},
): monaco.editor.IStandaloneCodeEditor {
  return monaco.editor.create(container, {
    value: options.value ?? "",
    language: options.language ?? "plaintext",
    automaticLayout: true,
    theme: "vs-dark",
  });
}

export function createTerminal(container: HTMLElement): { terminal: Terminal; fit: FitAddon } {
  const terminal = new Terminal({ convertEol: true });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  fit.fit();
  return { terminal, fit };
}
