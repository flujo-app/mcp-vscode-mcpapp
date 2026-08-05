// Guard the dispatcher tarball just before `npm pack`.
//
// Replaces the old Windows-only runtime check: the dispatcher now ships no runtime
// at all, so what matters is that it stays platform-neutral, that its metadata
// agrees with server.json, and that it points at the per-platform runtime packages.
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const PLATFORM_TARGETS = ["win32-x64", "linux-x64", "linux-arm64"];

const projectRoot = path.resolve(process.cwd());
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const serverJson = JSON.parse(await readFile(path.join(projectRoot, "server.json"), "utf8"));

if (packageJson.name !== "@mario.andreschak/mcp-vscode") {
  throw new Error(`Unexpected npm package name: ${JSON.stringify(packageJson.name)}`);
}
if (packageJson.os || packageJson.cpu) {
  throw new Error(
    `The dispatcher must not declare os/cpu (found os=${JSON.stringify(packageJson.os)}, cpu=${JSON.stringify(packageJson.cpu)}); ` +
      "those gates belong on the per-platform runtime packages",
  );
}
if (packageJson.files.includes("runtime")) {
  throw new Error("The dispatcher must not ship `runtime`; the platform packages carry it");
}
if (packageJson.mcpName !== serverJson.name) {
  throw new Error(
    `package.json mcpName ${JSON.stringify(packageJson.mcpName)} does not match server.json name ${JSON.stringify(serverJson.name)}`,
  );
}
if (packageJson.version !== serverJson.version || packageJson.version !== serverJson.packages?.[0]?.version) {
  throw new Error("package.json and server.json versions must match");
}
if (packageJson.name !== serverJson.packages?.[0]?.identifier) {
  throw new Error("package.json name and server.json npm identifier must match");
}

// Every platform must be declared and pinned exactly, otherwise a host silently
// resolves no runtime and the IDE fails to start after a successful install.
for (const target of PLATFORM_TARGETS) {
  const dependency = `${packageJson.name}-${target}`;
  const declared = packageJson.optionalDependencies?.[dependency];
  if (declared !== packageJson.version) {
    throw new Error(
      `optionalDependencies["${dependency}"] must be pinned to ${packageJson.version}, found ${JSON.stringify(declared)}. ` +
        "Run `npm run npm:prepare-manifest` before packing.",
    );
  }
}

for (const relativePath of ["dist/cli.js", "dist/app.html", "dist/bridge-extension/extension.cjs"]) {
  await access(path.join(projectRoot, ...relativePath.split("/")));
}

console.log(
  `Verified platform-neutral dispatcher ${packageJson.name}@${packageJson.version} ` +
    `(runtime packages: ${PLATFORM_TARGETS.join(", ")})`,
);
