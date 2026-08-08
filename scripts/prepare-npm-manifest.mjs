// Stage the platform-neutral dispatcher manifest for `npm pack`.
//
// The published dispatcher carries no OpenVSCode runtime. Instead it declares one
// optionalDependency per supported platform; npm installs only the package whose
// os/cpu match the host, and the runtime resolver locates it at startup. This is
// what makes `npx @mario.andreschak/mcp-vscode` work on every supported platform.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PLATFORM_TARGETS = ["win32-x64", "linux-x64", "linux-arm64"];

const projectRoot = path.resolve(process.cwd());
const packagePath = path.join(projectRoot, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const serverJson = JSON.parse(await readFile(path.join(projectRoot, "server.json"), "utf8"));
const runtimePackageVersion = packageJson.mcpVscodeRuntimeVersion ?? packageJson.version;

if (packageJson.version !== serverJson.version) {
  throw new Error(
    `package.json version ${JSON.stringify(packageJson.version)} does not match server.json ${JSON.stringify(serverJson.version)}`,
  );
}

// The dispatcher must stay installable everywhere; a leftover gate from the old
// Windows-only pipeline would silently exclude every other platform again.
delete packageJson.os;
delete packageJson.cpu;

if (packageJson.files.includes("runtime")) {
  throw new Error("The dispatcher manifest must not ship `runtime`; the platform packages carry it");
}

packageJson.optionalDependencies = {
  ...packageJson.optionalDependencies,
  ...Object.fromEntries(
    PLATFORM_TARGETS.map((target) => [`${packageJson.name}-${target}`, runtimePackageVersion]),
  ),
};

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(
  `Staged platform-neutral npm manifest with runtime packages ${runtimePackageVersion}: ${PLATFORM_TARGETS.join(", ")}`,
);
