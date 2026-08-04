import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`The npm release manifest must be staged on Windows x64, not ${process.platform}-${process.arch}`);
}

const projectRoot = path.resolve(process.cwd());
const metadata = JSON.parse(await readFile(path.join(projectRoot, "runtime", "openvscode-runtime.json"), "utf8"));
if (metadata.target !== "win32-x64") {
  throw new Error(`Cannot stage npm manifest for runtime target ${JSON.stringify(metadata.target)}`);
}

const packagePath = path.join(projectRoot, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
packageJson.os = ["win32"];
packageJson.cpu = ["x64"];
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log("Staged npm manifest for Windows x64");
