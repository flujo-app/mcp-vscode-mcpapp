import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const supportedTargets = new Set(["linux-x64", "linux-arm64", "win32-x64"]);
if (!supportedTargets.has(target)) {
  throw new Error(`Verified standalone packaging supports: ${[...supportedTargets].join(", ")}`);
}
run(process.execPath, ["scripts/build.mjs"]);
if (target.startsWith("win32-")) run(process.execPath, ["scripts/build-openvscode-windows.mjs", target]);
else run(process.execPath, ["scripts/fetch-openvscode.mjs", target]);

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const outRoot = path.resolve(root, "standalone");
const out = path.join(outRoot, `mcp-vscode-${packageJson.version}-${target}`);
if (path.dirname(outRoot) !== root) throw new Error(`Unsafe standalone path: ${outRoot}`);
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "app"), { recursive: true });
await cp(path.join(root, "dist"), path.join(out, "app", "dist"), { recursive: true });
await cp(path.join(root, "runtime", "openvscode-server"), path.join(out, "runtime", "openvscode-server"), { recursive: true });
await cp(path.join(root, "runtime", "openvscode-runtime.json"), path.join(out, "runtime", "openvscode-runtime.json"));
const runtimePty = path.join(root, "runtime", "openvscode-server", "node_modules", "node-pty");
await access(path.join(runtimePty, "package.json"));
await cp(runtimePty, path.join(out, "app", "node_modules", "node-pty"), { recursive: true });
await cp(path.join(root, "third_party"), path.join(out, "licenses", "upstream"), { recursive: true });
await copyProductionLicenses(root, path.join(out, "licenses", "npm"));
for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
  await cp(path.join(root, file), path.join(out, file));
}

await mkdir(path.join(out, "bin"), { recursive: true });
if (target.startsWith("win32-")) {
  const launcher = `@echo off\r\nsetlocal\r\nset "ROOT=%~dp0.."\r\nset "NODE=%ROOT%\\runtime\\openvscode-server\\node.exe"\r\nif not exist "%NODE%" (\r\n  echo Bundled Node.js runtime not found: %NODE% 1>&2\r\n  exit /b 1\r\n)\r\n"%NODE%" "%ROOT%\\app\\dist\\cli.js" --openvscode-root "%ROOT%\\runtime\\openvscode-server" %*\r\nexit /b %ERRORLEVEL%\r\n`;
  await writeFile(path.join(out, "bin", "mcp-vscode.cmd"), launcher);
} else {
  const launcher = `#!/usr/bin/env sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nNODE="$ROOT/runtime/openvscode-server/node"\nif [ ! -x "$NODE" ]; then NODE="$ROOT/runtime/openvscode-server/bin/helpers/node"; fi\nexec "$NODE" "$ROOT/app/dist/cli.js" --openvscode-root "$ROOT/runtime/openvscode-server" "$@"\n`;
  await writeFile(path.join(out, "bin", "mcp-vscode"), launcher, { mode: 0o755 });
}
console.log(`Created standalone directory: ${out}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

async function copyProductionLicenses(projectRoot, destination) {
  const packageLock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  const packages = packageLock.packages ?? {};
  const manifest = [];
  const copied = new Set();
  for (const [packagePath, lockEntry] of Object.entries(packages)) {
    if (!packagePath.startsWith("node_modules/") || lockEntry.dev === true) continue;
    const source = path.join(projectRoot, ...packagePath.split("/"));
    let packageJson;
    try {
      packageJson = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    } catch {
      if (lockEntry.optional === true) continue;
      throw new Error(`Production dependency is missing from node_modules: ${packagePath}`);
    }
    const identity = `${packageJson.name ?? packagePath}@${packageJson.version ?? lockEntry.version ?? "unknown"}`;
    if (copied.has(identity)) continue;
    copied.add(identity);
    const packageDestination = path.join(destination, identity.replaceAll("/", "__"));
    await mkdir(packageDestination, { recursive: true });
    await cp(path.join(source, "package.json"), path.join(packageDestination, "package.json"));
    const entries = await readdir(source, { withFileTypes: true });
    const licenseFiles = entries
      .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name))
      .map((entry) => entry.name);
    for (const licenseFile of licenseFiles) {
      await cp(path.join(source, licenseFile), path.join(packageDestination, licenseFile));
    }
    manifest.push({
      name: packageJson.name ?? packagePath,
      version: packageJson.version ?? lockEntry.version,
      license: packageJson.license ?? lockEntry.license ?? "SEE PACKAGE METADATA",
      licenseFiles,
    });
  }
  manifest.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  await writeFile(path.join(destination, "dependencies.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
