import { spawnSync } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const VERSION = "1.109.5";
const SOURCE_REPOSITORY = "https://github.com/gitpod-io/openvscode-server.git";
const SOURCE_TAG = `openvscode-server-v${VERSION}`;
const SOURCE_COMMIT = "4ffe2270acdf711bbefecc3e8c79f4b3631640e5";
const TARGETS = {
  "win32-x64": { arch: "x64", output: "vscode-reh-web-win32-x64" },
};

const requested = process.argv[2] ?? `${process.platform}-${process.arch}`;
const target = TARGETS[requested];
if (!target) {
  throw new Error(`Native Windows runtime builds support: ${Object.keys(TARGETS).join(", ")}`);
}
if (process.platform !== "win32") {
  throw new Error(`${requested} must be built on Windows so its native modules are compiled for Windows`);
}
if (process.arch !== target.arch) {
  throw new Error(`${requested} requires a ${target.arch} Node.js build host; current Node.js is ${process.arch}`);
}

const projectRoot = path.resolve(process.cwd());
const runtimeRoot = path.join(projectRoot, "runtime");
const configuredSource = process.env.MCP_VSCODE_OPENVSCODE_SOURCE;
const buildRoot = path.resolve(
  process.env.MCP_VSCODE_BUILD_ROOT
    ?? path.join(os.tmpdir(), "mcp-vscode-openvscode-build", `${VERSION}-${requested}`),
);
const sourceRoot = configuredSource ? path.resolve(configuredSource) : path.join(buildRoot, "source");
const outputRoot = path.resolve(sourceRoot, "..", target.output);
const destination = path.join(runtimeRoot, "openvscode-server");

assertChild(runtimeRoot, destination, "runtime destination");
if (!configuredSource) assertChild(buildRoot, sourceRoot, "OpenVSCode source cache");

await mkdir(runtimeRoot, { recursive: true });
await mkdir(buildRoot, { recursive: true });
await ensureSource();
await verifyBuildNode();
await verifyBuildToolchain();

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
);
const buildEnv = {
  ...inheritedEnv,
  Path: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  VSCODE_ARCH: target.arch,
  npm_config_arch: target.arch,
  npm_config_foreground_scripts: "true",
};

runNpm(["ci"], { cwd: sourceRoot, env: buildEnv });
await verifyTypeDeclarationIsolation();
run(process.execPath, ["build/lib/builtInExtensions.ts"], { cwd: sourceRoot, env: buildEnv });
runNpm(["run", "gulp", `${target.output}-min`], { cwd: sourceRoot, env: buildEnv });

await verifyRuntime(outputRoot);
await rm(destination, { recursive: true, force: true });
await cp(outputRoot, destination, { recursive: true });
await writeFile(
  path.join(runtimeRoot, "openvscode-runtime.json"),
  `${JSON.stringify({
    version: VERSION,
    target: requested,
    sourceRepository: SOURCE_REPOSITORY,
    sourceTag: SOURCE_TAG,
    sourceCommit: SOURCE_COMMIT,
    buildNodeVersion: process.version,
  }, null, 2)}\n`,
);

console.log(`Built and installed OpenVSCode ${VERSION} for ${requested} in ${destination}`);

async function ensureSource() {
  if (configuredSource) {
    await access(path.join(sourceRoot, ".git"));
  } else {
    let reusable = false;
    try {
      reusable = runCapture("git", ["-C", sourceRoot, "rev-parse", "HEAD"]) === SOURCE_COMMIT;
    } catch {
      reusable = false;
    }
    if (!reusable) {
      await rm(sourceRoot, { recursive: true, force: true });
      run("git", ["clone", "--depth", "1", "--branch", SOURCE_TAG, SOURCE_REPOSITORY, sourceRoot], { cwd: buildRoot });
    }
  }

  const actualCommit = runCapture("git", ["-C", sourceRoot, "rev-parse", "HEAD"]);
  if (actualCommit !== SOURCE_COMMIT) {
    throw new Error(`OpenVSCode source mismatch: expected ${SOURCE_COMMIT}, got ${actualCommit}`);
  }
}

async function verifyBuildNode() {
  const required = (await readFile(path.join(sourceRoot, ".nvmrc"), "utf8")).trim();
  if (compareVersions(process.versions.node, required) < 0) {
    throw new Error(
      `OpenVSCode ${VERSION} requires Node.js ${required} or newer to build; current Node.js is ${process.versions.node}`,
    );
  }
}

async function verifyBuildToolchain() {
  const candidates = [
    process.env.vs2022_install,
    ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter(Boolean)
      .flatMap((programFiles) => ["Enterprise", "Professional", "Community", "BuildTools", "Preview"]
        .map((edition) => path.join(programFiles, "Microsoft Visual Studio", "2022", edition))),
  ].filter(Boolean);

  for (const visualStudioRoot of candidates) {
    const toolsRoot = path.join(visualStudioRoot, "VC", "Tools", "MSVC");
    let versions = [];
    try {
      versions = await readdir(toolsRoot);
    } catch {
      continue;
    }
    for (const version of versions.sort().reverse()) {
      try {
        await access(path.join(toolsRoot, version, "lib", "spectre", target.arch));
        return;
      } catch {
        // Check the next installed toolset.
      }
    }
  }

  throw new Error(
    "Visual Studio 2022 is missing Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre, "
      + "which Code OSS requires when compiling native Windows modules",
  );
}

async function verifyTypeDeclarationIsolation() {
  let current = sourceRoot;
  while (true) {
    const declarationPackage = path.join(current, "node_modules", "@types", "vscode", "package.json");
    try {
      await access(declarationPackage);
      throw new Error(
        `OpenVSCode source is not isolated: ${declarationPackage} would conflict with its bundled vscode.d.ts. `
          + "Build from a directory whose parents do not contain @types/vscode.",
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function verifyRuntime(root) {
  const required = [
    "node.exe",
    "bin/openvscode-server.cmd",
    "out/server-main.js",
    "node_modules/node-pty/package.json",
  ];
  for (const relative of required) {
    await access(path.join(root, ...relative.split("/")));
  }
}

function runNpm(args, options) {
  const npmCli = process.env.npm_execpath
    ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  run(process.execPath, [npmCli, ...args], options);
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${String(result.status)}`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed with ${String(result.status)}`);
  return result.stdout.trim();
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertChild(parent, child, label) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe ${label}: ${child}`);
  }
}
