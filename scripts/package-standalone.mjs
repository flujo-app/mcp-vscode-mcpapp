import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!target.startsWith("linux-")) throw new Error("Verified standalone packaging currently supports Linux targets only");
run(process.execPath, ["scripts/build.mjs"]);
run(process.execPath, ["scripts/fetch-openvscode.mjs", target]);

const root = process.cwd();
const outRoot = path.resolve(root, "standalone");
const out = path.join(outRoot, `mcp-vscode-0.1.0-${target}`);
if (path.dirname(outRoot) !== root) throw new Error(`Unsafe standalone path: ${outRoot}`);
await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "app"), { recursive: true });
await cp(path.join(root, "dist"), path.join(out, "app", "dist"), { recursive: true });
await cp(path.join(root, "runtime", "openvscode-server"), path.join(out, "runtime", "openvscode-server"), { recursive: true });
const runtimePty = path.join(root, "runtime", "openvscode-server", "node_modules", "node-pty");
await access(path.join(runtimePty, "package.json"));
await cp(runtimePty, path.join(out, "app", "node_modules", "node-pty"), { recursive: true });
await cp(path.join(root, "third_party"), path.join(out, "licenses", "upstream"), { recursive: true });
await copyProductionLicenses(root, path.join(out, "licenses", "npm"));
for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
  await cp(path.join(root, file), path.join(out, file));
}

const launcher = `#!/usr/bin/env sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nNODE="$ROOT/runtime/openvscode-server/node"\nif [ ! -x "$NODE" ]; then NODE="$ROOT/runtime/openvscode-server/bin/helpers/node"; fi\nexec "$NODE" "$ROOT/app/dist/cli.js" --openvscode-root "$ROOT/runtime/openvscode-server" "$@"\n`;
await mkdir(path.join(out, "bin"), { recursive: true });
await writeFile(path.join(out, "bin", "mcp-vscode"), launcher, { mode: 0o755 });
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
