import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd());
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const readText = (relative) => readFile(path.join(root, relative), "utf8");

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const serverJson = await readJson("server.json");
const bridgeManifest = await readJson("src/bridge-extension/package.json");
const version = packageJson.version;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const problems = [];

if (typeof version !== "string" || !semver.test(version)) {
  problems.push(`package.json has invalid version ${JSON.stringify(version)}`);
}

check("package-lock.json version", packageLock.version);
check("package-lock.json root package version", packageLock.packages?.[""]?.version);
check("server.json version", serverJson.version);
check("bridge extension version", bridgeManifest.version);

const npmServerPackage = serverJson.packages?.find(
  (entry) => entry.registryType === "npm" && entry.identifier === packageJson.name,
);
if (!npmServerPackage) {
  problems.push(`server.json has no npm package entry for ${packageJson.name}`);
} else {
  check("server.json npm package version", npmServerPackage.version);
}

for (const relative of ["src/app/main.ts", "src/mcp/server.ts", "src/runtime/openvscode.ts"]) {
  const content = await readText(relative);
  const marked = content.split(/\r?\n/).filter((line) => line.includes("x-release-please-version"));
  if (marked.length !== 1) {
    problems.push(`${relative} must contain exactly one x-release-please-version line (found ${marked.length})`);
    continue;
  }
  const found = marked[0].match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g) ?? [];
  if (found.length !== 1) {
    problems.push(`${relative} release marker must contain exactly one version (found ${found.length})`);
    continue;
  }
  check(`${relative} release marker`, found[0]);
}

const readme = await readText("README.md");
checkReadmeReleaseMarkers(readme);
const readmePackageVersions = [
  ...readme.matchAll(/@mario\.andreschak\/mcp-vscode@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/g),
].map((match) => match[1]);
const readmeArtifactVersions = [
  ...readme.matchAll(/release-artifacts-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/g),
].map((match) => match[1]);
checkReadmeVersions("npm package examples", readmePackageVersions);
checkReadmeVersions("release artifact examples", readmeArtifactVersions);

if (problems.length > 0) {
  throw new Error(`Project versions are out of sync:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
}

console.log(`Verified project version ${version} across manifests, source metadata, and README examples.`);

function check(label, actual) {
  if (actual !== version) problems.push(`${label} is ${JSON.stringify(actual)}, expected ${version}`);
}

function checkReadmeVersions(label, values) {
  if (values.length === 0) {
    problems.push(`README ${label} contain no versioned example`);
    return;
  }
  for (const actual of values) check(`README ${label}`, actual);
}

function checkReadmeReleaseMarkers(content) {
  const lines = content.split(/\r?\n/);
  let inVersionBlock = false;

  for (const [index, line] of lines.entries()) {
    if (line.includes("x-release-please-start-version")) {
      if (inVersionBlock) problems.push(`README has nested release version blocks at line ${index + 1}`);
      inVersionBlock = true;
      continue;
    }

    const hasProjectVersion =
      line.includes("@mario.andreschak/mcp-vscode@") || line.includes("release-artifacts-v");
    if (hasProjectVersion && !inVersionBlock) {
      problems.push(`README project version at line ${index + 1} is outside a Release Please version block`);
    }

    if (inVersionBlock) {
      const versions = line.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g) ?? [];
      if (versions.length > 1) {
        problems.push(
          `README release block line ${index + 1} contains ${versions.length} versions; ` +
            "Release Please updates only one version per line",
        );
      }
      for (const actual of versions) check(`README release block line ${index + 1}`, actual);
    }

    if (line.includes("x-release-please-end")) {
      if (!inVersionBlock) problems.push(`README has an unmatched release block end at line ${index + 1}`);
      inVersionBlock = false;
    }
  }

  if (inVersionBlock) problems.push("README has an unclosed Release Please version block");
}
