// Publish a built release to npm from CI-produced tarballs.
//
// Usage:
//   npm run npm:publish -- <artifacts-dir> [--dry-run] [--tag <dist-tag>]
//                          [--wait-for-login] [--no-login]
//                          [--trusted-publishing] [--dispatcher-only]
//
// Publishing is deliberately split from packing: this script never builds a
// tarball, it only verifies and uploads the ones the Release workflow produced.
// That keeps the published bytes byte-identical to the audited artifacts.
//
// Interactive npm auth (passkey / WebAuthn) runs IN THIS terminal: when no
// session is present the script hands the terminal to `npm login --auth-type=web`,
// which opens a browser and returns here once sign-in completes. Pass
// `--wait-for-login` to keep the old behaviour instead (log in from a second
// terminal with `npm run npm:login` while this one polls), or `--no-login` to
// fail fast when no session exists - useful for CI.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import semver from "semver";
import { list } from "tar";
import { normalizeNpmViewPayload, npmSpawn } from "./lib/npm-spawn.mjs";

const REGISTRY = "https://registry.npmjs.org";
// Runtime packages MUST publish before the dispatcher that pins them as
// optionalDependencies; otherwise `npx` can resolve a dispatcher whose runtime
// packages do not exist yet.
const PLATFORM_TARGETS = ["linux-x64", "linux-arm64", "win32-x64"];
const LOGIN_POLL_MS = 5000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const trustedPublishing = argv.includes("--trusted-publishing");
const dispatcherOnly = argv.includes("--dispatcher-only");
// Interactive login in this terminal is the default; these opt out of it.
const waitForLoginOnly = argv.includes("--wait-for-login");
const noLogin = argv.includes("--no-login");
const distTagIndex = argv.indexOf("--tag");
const distTag = distTagIndex === -1 ? "latest" : argv[distTagIndex + 1];
if (distTagIndex !== -1 && !distTag) throw new Error("--tag requires a value");
const positional = argv.filter((value, index) => {
  if (value.startsWith("--")) return false;
  if (distTagIndex !== -1 && index === distTagIndex + 1) return false;
  return true;
});

const projectRoot = path.resolve(process.cwd());
const rootManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = rootManifest.version;
if (!semver.valid(version)) throw new Error(`package.json has invalid version ${JSON.stringify(version)}`);
let runtimePackageVersion = dispatcherOnly ? undefined : version;
const tag = `v${version}`;
const artifactsDir = path.resolve(positional[0] ?? path.join(projectRoot, `release-artifacts-${tag}`));

console.log(`Publishing ${rootManifest.name}@${version} (dist-tag: ${distTag})`);
console.log(`Artifacts: ${artifactsDir}`);
if (dryRun) console.log("DRY RUN - nothing will be uploaded\n");
if (trustedPublishing) console.log("Authentication: npm trusted publishing (OIDC)");
if (dispatcherOnly) console.log("Scope: dispatcher package only");

const available = await readdir(artifactsDir).catch(() => {
  throw new Error(
    `Artifacts directory not found: ${artifactsDir}\n` +
      `Download the ${tag} assets from the GitHub Release into that directory first.`,
  );
});

// Resolve every tarball up front so a missing file fails before we publish
// anything, rather than halfway through and leaving a partial release.
const planned = [];
if (!dispatcherOnly) {
  for (const target of PLATFORM_TARGETS) {
    planned.push({
      file: `mcp-vscode-${tag}-${target}.npm.tgz`,
      expectedName: `${rootManifest.name}-${target}`,
      target,
    });
  }
}
planned.push({
  file: `mcp-vscode-${tag}-dispatcher.npm.tgz`,
  expectedName: rootManifest.name,
  target: "dispatcher",
});

const missing = planned.filter((entry) => !available.includes(entry.file));
if (missing.length > 0) {
  throw new Error(
    `Missing release tarballs in ${artifactsDir}:\n` +
      missing.map((entry) => `  - ${entry.file}`).join("\n") +
      `\nAll ${planned.length} tarballs must be present before publishing.`,
  );
}

for (const entry of planned) {
  const file = path.join(artifactsDir, entry.file);
  entry.integrity = await verifyChecksum(file);
  const manifest = await readPackedManifest(file);

  // The single most dangerous mistake in this layout is uploading a runtime
  // tarball under the dispatcher's name (or vice versa): it would break every
  // install of the primary package. Verify identity from the tarball itself.
  if (manifest.name !== entry.expectedName) {
    throw new Error(
      `${entry.file} contains ${JSON.stringify(manifest.name)} but should contain ${JSON.stringify(entry.expectedName)}`,
    );
  }
  if (manifest.version !== version) {
    throw new Error(`${entry.file} is version ${manifest.version}, expected ${version}`);
  }
  if (entry.target === "dispatcher") {
    if (manifest.os || manifest.cpu) {
      throw new Error(`${entry.file} declares os/cpu; the dispatcher must stay platform-neutral`);
    }
    const declaredRuntimeVersions = PLATFORM_TARGETS.map(
      (target) => manifest.optionalDependencies?.[`${rootManifest.name}-${target}`],
    );
    const uniqueRuntimeVersions = new Set(declaredRuntimeVersions);
    if (
      uniqueRuntimeVersions.size !== 1 ||
      typeof declaredRuntimeVersions[0] !== "string" ||
      !semver.valid(declaredRuntimeVersions[0])
    ) {
      throw new Error(
        `Dispatcher runtime dependencies must all pin one valid version, found ${JSON.stringify(declaredRuntimeVersions)}`,
      );
    }
    const declaredRuntimeVersion = declaredRuntimeVersions[0];
    if (dispatcherOnly) runtimePackageVersion = declaredRuntimeVersion;
    if (declaredRuntimeVersion !== runtimePackageVersion) {
      throw new Error(
        `Dispatcher pins runtime ${declaredRuntimeVersion}, expected ${runtimePackageVersion} for this release`,
      );
    }
  } else if (!manifest.os || !manifest.cpu) {
    throw new Error(`${entry.file} is missing the os/cpu gate required for a runtime package`);
  }

  entry.path = file;
  entry.manifest = manifest;
  console.log(`  verified ${entry.file} -> ${manifest.name}@${manifest.version}`);
}

if (dispatcherOnly) {
  const missingRuntimes = PLATFORM_TARGETS.map((target) => `${rootManifest.name}-${target}`).filter((name) => {
    const publishedVersion = npmViewField(name, runtimePackageVersion, "version");
    return publishedVersion !== runtimePackageVersion;
  });
  if (missingRuntimes.length > 0) {
    throw new Error(
      `Cannot publish the dispatcher: its runtime version ${runtimePackageVersion} is missing from npm for:\n` +
        missingRuntimes.map((name) => `  - ${name}`).join("\n"),
    );
  }
  console.log(`  verified all platform runtime packages at ${runtimePackageVersion}`);
}

// Skip anything already on the registry so an interrupted run can simply be
// re-run instead of needing manual bookkeeping.
for (const entry of planned) {
  const registryIntegrity = npmViewField(entry.manifest.name, version, "dist.integrity");
  entry.published = registryIntegrity !== undefined;
  if (!entry.published) continue;
  if (typeof registryIntegrity !== "string" || registryIntegrity !== entry.integrity) {
    throw new Error(
      `${entry.manifest.name}@${version} already exists on npm with different bytes.\n` +
        `  registry: ${JSON.stringify(registryIntegrity)}\n` +
        `  artifact: ${entry.integrity}\n` +
        "Refusing to resume around an unaudited package.",
    );
  }
  console.log(`  already published with matching integrity: ${entry.manifest.name}@${version}`);
}

// An older failed workflow can be retried after a newer release has succeeded.
// Never let that recovery move a primary dist-tag such as `latest` or `beta`
// backwards; publish the missing immutable version under a recovery tag instead.
for (const entry of planned) {
  if (entry.published) continue;
  const taggedVersion = npmViewField(entry.manifest.name, distTag, "version");
  if (taggedVersion === undefined) continue;
  if (typeof taggedVersion !== "string" || !semver.valid(taggedVersion)) {
    throw new Error(
      `npm returned invalid version ${JSON.stringify(taggedVersion)} for ${entry.manifest.name}@${distTag}`,
    );
  }
  if (semver.gt(taggedVersion, version)) {
    throw new Error(
      `Refusing to move npm dist-tag ${distTag} backwards for ${entry.manifest.name}.\n` +
        `  currently tagged: ${taggedVersion}\n` +
        `  attempted release: ${version}\n` +
        "Publish the missing immutable version with a non-primary recovery tag instead.",
    );
  }
}

if (planned.every((entry) => entry.published)) {
  console.log(`\nEverything for ${version} is already on npm. Nothing to do.`);
  process.exit(0);
}

if (!dryRun && !trustedPublishing) await ensureLogin();

console.log("");
for (const entry of planned) {
  if (entry.published) continue;
  const label = `${entry.manifest.name}@${version}`;
  if (dryRun) {
    console.log(`would publish ${label}  (${entry.file})`);
    continue;
  }
  console.log(`publishing ${label} ...`);
  const args = ["publish", entry.path, "--access", "public", "--tag", distTag, "--registry", REGISTRY];
  if (trustedPublishing) args.push("--provenance");
  const result = npmSpawn(args, { stdio: "inherit", cwd: artifactsDir });
  if (result.status !== 0) {
    throw new Error(
      `npm publish failed for ${label}.\n` +
        (entry.target === "dispatcher"
          ? "The runtime packages are already live; re-run this script to retry just the dispatcher."
          : "Re-run this script to resume; already-published packages are skipped."),
    );
  }
  console.log(`published ${label}\n`);
}

console.log(dryRun ? "Dry run complete." : `Published ${rootManifest.name}@${version} for all platforms.`);

async function verifyChecksum(file) {
  const checksumFile = `${file}.sha256`;
  const recorded = await readFile(checksumFile, "utf8").catch(() => undefined);
  if (!recorded) {
    throw new Error(`Missing checksum file: ${path.basename(checksumFile)}`);
  }
  const expected = recorded.trim().split(/\s+/)[0]?.toLowerCase();
  const bytes = await readFile(file);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (expected !== actual) {
    throw new Error(`Checksum mismatch for ${path.basename(file)}: expected ${expected}, got ${actual}`);
  }
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function readPackedManifest(file) {
  let raw;
  const capture = (entry) => {
    if (entry.path !== "package/package.json") return;
    const chunks = [];
    entry.on("data", (chunk) => chunks.push(chunk));
    entry.on("end", () => {
      raw = Buffer.concat(chunks).toString("utf8");
    });
  };
  await list({
    file,
    filter: (entryPath) => entryPath === "package/package.json",
    onReadEntry: capture,
    onentry: capture,
  });
  if (!raw) throw new Error(`${path.basename(file)} does not contain package/package.json`);
  // Strip a UTF-8 BOM: it is legal in the file but makes JSON.parse throw.
  return JSON.parse(raw.replace(/^﻿/, ""));
}

function npmViewField(name, wanted, field) {
  const spec = `${name}@${wanted}`;
  const result = npmSpawn(["view", spec, field, "--json", "--registry", REGISTRY], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`Could not query ${spec}: ${result.error.message}`);

  let payload;
  try {
    payload = JSON.parse(result.stdout || "null");
  } catch {
    throw new Error(`npm returned invalid JSON while querying ${spec} ${field}`);
  }
  if (result.status === 0) return normalizeNpmViewPayload(payload);
  if (payload?.error?.code === "E404") return undefined;
  throw new Error(`npm view failed for ${spec}:\n${result.stderr || result.stdout || "unknown error"}`);
}

function currentUser() {
  const result = npmSpawn(["whoami", "--registry", REGISTRY], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function ensureLogin() {
  const existing = currentUser();
  if (existing) {
    console.log(`\nAuthenticated as ${existing}`);
    return;
  }
  if (noLogin) {
    throw new Error(
      `Not logged in to ${REGISTRY} and --no-login was passed.\n` +
        "Provide a token (NODE_AUTH_TOKEN / .npmrc) or drop --no-login to sign in interactively.",
    );
  }
  if (waitForLoginOnly) {
    await waitForExternalLogin();
    return;
  }
  if (!process.stdin.isTTY) {
    console.log("\nNot logged in to npm and this terminal is not interactive; waiting for an external login.");
    await waitForExternalLogin();
    return;
  }

  // Run the interactive login in THIS terminal: `npm login --auth-type=web`
  // prints a URL, opens the browser for passkey / WebAuthn and returns once the
  // session is stored, so no second terminal is needed.
  console.log(
    [
      "",
      `Not logged in to ${REGISTRY}. Starting \`npm login --auth-type=web\` here.`,
      "A browser window opens for passkey / WebAuthn sign-in; publishing resumes",
      "automatically afterwards. Ctrl-C to abort.",
      "",
    ].join("\n"),
  );
  const login = npmSpawn(["login", "--auth-type=web", "--registry", REGISTRY], { stdio: "inherit" });
  if (login.error) throw new Error(`Could not start npm login: ${login.error.message}`);

  // Trust `npm whoami` rather than the exit code: some npm versions exit
  // non-zero after a successful web login when the browser closes early.
  const user = currentUser();
  if (user) {
    console.log(`\nAuthenticated as ${user}`);
    return;
  }
  if (login.status !== 0) {
    throw new Error(
      `npm login exited with status ${login.status ?? "unknown"} and no session was created.\n` +
        "Re-run this script to try again, or run `npm run npm:login` manually and then\n" +
        "re-run with --wait-for-login.",
    );
  }
  throw new Error("npm login finished but `npm whoami` still reports no session. Re-run this script to retry.");
}

async function waitForExternalLogin() {
  console.log(
    [
      "",
      "Waiting for an npm login from another terminal.",
      "",
      "  In a SECOND terminal in this repository run:",
      "",
      "      npm run npm:login",
      "",
      "  That opens a browser for passkey / WebAuthn sign-in. This terminal continues",
      "  automatically once the login lands. Ctrl-C to abort.",
      "",
    ].join("\n"),
  );
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
    const user = currentUser();
    if (user) {
      console.log(`\nAuthenticated as ${user}`);
      return;
    }
    process.stdout.write(".");
  }
  throw new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 60000} minutes waiting for npm login`);
}
