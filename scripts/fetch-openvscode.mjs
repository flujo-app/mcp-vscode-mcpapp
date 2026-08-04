import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { extract } from "tar";

const VERSION = "1.109.5";
const RELEASE = `openvscode-server-v${VERSION}`;
const TARGETS = {
  "linux-x64": {
    asset: `${RELEASE}-linux-x64.tar.gz`,
    sha256: "b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363",
  },
  "linux-arm64": {
    asset: `${RELEASE}-linux-arm64.tar.gz`,
    sha256: "36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc",
  },
};

const requested = process.argv[2] ?? `${process.platform}-${process.arch}`;
const target = TARGETS[requested];
if (!target) {
  throw new Error(`No verified OpenVSCode binary for ${requested}. Supported targets: ${Object.keys(TARGETS).join(", ")}`);
}
const root = process.cwd();
const runtimeDir = path.resolve(root, "runtime");
const destination = path.join(runtimeDir, "openvscode-server");
if (path.dirname(runtimeDir) !== root) throw new Error(`Unsafe runtime path: ${runtimeDir}`);
await mkdir(runtimeDir, { recursive: true });
const archive = path.join(runtimeDir, target.asset);
const url = `https://github.com/gitpod-io/openvscode-server/releases/download/${RELEASE}/${target.asset}`;

if (!(await hasVerifiedArchive(archive, target.sha256))) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== target.sha256) throw new Error(`OpenVSCode checksum mismatch: expected ${target.sha256}, got ${actual}`);
  await writeFile(archive, bytes);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await extract({ file: archive, cwd: destination, strip: 1, strict: true });
await writeFile(
  path.join(runtimeDir, "openvscode-runtime.json"),
  JSON.stringify({ version: VERSION, target: requested, asset: target.asset, sha256: target.sha256, source: url }, null, 2),
);
console.log(`Installed OpenVSCode ${VERSION} for ${requested} in ${destination}`);

async function hasVerifiedArchive(file, expected) {
  try {
    const data = await readFile(file);
    return createHash("sha256").update(data).digest("hex") === expected;
  } catch {
    return false;
  }
}
