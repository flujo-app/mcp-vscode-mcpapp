import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export interface ChromiumDiscoveryOptions {
  override?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Find an already-installed Chromium-family browser. Nothing is downloaded
 * and no package-manager lookup is attempted.
 */
export async function discoverChromiumExecutable(
  options: ChromiumDiscoveryOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates = options.override
    ? [path.resolve(options.override)]
    : [...platformCandidates(platform, env), ...pathCandidates(platform, env)];

  for (const candidate of unique(candidates)) {
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  return undefined;
}

function platformCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
      .filter((value): value is string => Boolean(value));
    const relatives = [
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Chromium", "Application", "chrome.exe"],
    ];
    return roots.flatMap((root) => relatives.map((relative) => path.join(root, ...relative)));
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

function pathCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH;
  if (!pathValue) return [];
  const names = platform === "win32"
    ? ["msedge.exe", "chrome.exe", "chromium.exe"]
    : ["microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  return pathValue.split(path.delimiter).flatMap((directory) => {
    if (!directory) return [];
    return names.map((name) => path.join(directory, name));
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => path.normalize(value)))];
}
