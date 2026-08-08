// Loads the Phase-1 native-renderer bundle (`src/ui/index.ts`, built by
// `scripts/build.mjs` into `dist/app/assets/index-<hash>.js`) from the
// gateway's `assetsUrl`. The manifest maps logical names to their
// content-hashed filenames; `index.js` is deliberately never hashed
// (`NO_STORE_NAMES` in `src/http/assets.ts`) so a fresh build is always
// visible without a hard reload.
export interface UiAssetsModule {
  installMonacoEnvironment(assetsUrl: string): Promise<void>;
  createEditor(container: HTMLElement, options?: { value?: string; language?: string }): unknown;
  createTerminal(container: HTMLElement): { terminal: unknown; fit: unknown };
  /** The `monaco` namespace re-exported by `src/ui/index.ts`, so callers on
   * the app side (a different bundle/document) can reach `editor.createModel`,
   * `KeyMod`, `KeyCode`, etc. without a second cross-origin module load. */
  monaco: unknown;
}

type AssetManifest = Record<string, string>;

let cached: Promise<UiAssetsModule> | undefined;

export function loadUiAssets(assetsUrl: string): Promise<UiAssetsModule> {
  cached ??= loadImpl(assetsUrl);
  return cached;
}

/** Test/reset hook: allows a fresh load after a tier re-probe against a new
 * gateway origin (a restarted gateway gets a new ephemeral port). */
export function resetUiAssetsCache(): void {
  cached = undefined;
}

async function loadImpl(assetsUrl: string): Promise<UiAssetsModule> {
  const base = assetsUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/manifest.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`assets manifest fetch failed: HTTP ${response.status}`);
  const manifest = (await response.json()) as AssetManifest;
  const entry = manifest["index.js"];
  if (!entry) throw new Error("assets manifest is missing the index.js entry");
  const module = (await import(/* @vite-ignore */ `${base}/${entry}`)) as UiAssetsModule;
  await module.installMonacoEnvironment(assetsUrl);
  return module;
}
