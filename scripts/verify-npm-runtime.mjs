import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.cwd());
const runtimeRoot = path.join(projectRoot, "runtime", "openvscode-server");
const metadataPath = path.join(projectRoot, "runtime", "openvscode-runtime.json");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const serverJson = JSON.parse(await readFile(path.join(projectRoot, "server.json"), "utf8"));
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));

if (packageJson.name !== "@mario.andreschak/mcp-vscode") {
  throw new Error(`Unexpected npm package name: ${JSON.stringify(packageJson.name)}`);
}
if (JSON.stringify(packageJson.os) !== JSON.stringify(["win32"]) || JSON.stringify(packageJson.cpu) !== JSON.stringify(["x64"])) {
  throw new Error("The staged npm manifest must restrict installation to Windows x64");
}
if (packageJson.mcpName !== serverJson.name) {
  throw new Error(`package.json mcpName ${JSON.stringify(packageJson.mcpName)} does not match server.json name ${JSON.stringify(serverJson.name)}`);
}
if (packageJson.version !== serverJson.version || packageJson.version !== serverJson.packages?.[0]?.version) {
  throw new Error("package.json and server.json versions must match");
}
if (packageJson.name !== serverJson.packages?.[0]?.identifier) {
  throw new Error("package.json name and server.json npm identifier must match");
}

if (metadata.target !== "win32-x64") {
  throw new Error(
    `Refusing to pack the Windows npm package with runtime target ${JSON.stringify(metadata.target)}; expected "win32-x64"`,
  );
}

for (const relativePath of [
  "node.exe",
  "bin/openvscode-server.cmd",
  "out/server-main.js",
  "node_modules/node-pty/package.json",
]) {
  await access(path.join(runtimeRoot, ...relativePath.split("/")));
}

console.log(`Verified ${metadata.target} OpenVSCode runtime for npm packaging`);
