// Node 22.23.2 is a security release. Keep the OpenVSCode ABI major while
// replacing its old bundled Node patch with independently verified official bytes.
// Sources: https://nodejs.org/en/blog/release/v22.23.2 and its signed SHASUMS.
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  chmod,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { extract } from "tar";
const version = "22.23.2";
const targets = {
  "linux-x64": {
    asset: "node-v22.23.2-linux-x64.tar.gz",
    sha256: "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
  },
  "linux-arm64": {
    asset: "node-v22.23.2-linux-arm64.tar.gz",
    sha256: "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30",
  },
  "win32-x64": {
    asset: "win-x64/node.exe",
    sha256: "0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4",
  },
};
export async function refreshRuntimeNode(target, root = process.cwd()) {
  const spec = targets[target];
  if (!spec) throw new Error("Unsupported Node runtime target");
  const runtime = path.join(root, "runtime", "openvscode-server");
  const stagingRoot = path.join(root, "runtime");
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(path.join(stagingRoot, "node-refresh-"));
  try {
    const url = "https://nodejs.org/dist/v" + version + "/" + spec.asset;
    const bytes = await download(url, 150 * 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== spec.sha256)
      throw new Error("Node runtime checksum mismatch");
    if (target.startsWith("win32")) {
      await writeFile(path.join(staging, "node.exe"), bytes);
      await rename(
        path.join(staging, "node.exe"),
        path.join(runtime, "node.exe"),
      );
      const license = await download(
        "https://raw.githubusercontent.com/nodejs/node/v" +
          version +
          "/LICENSE",
        2 * 1024 * 1024,
      );
      await writeFile(path.join(runtime, "node-runtime-LICENSE"), license);
    } else {
      const archive = path.join(staging, "node.tar.gz");
      await writeFile(archive, bytes);
      await extract({
        file: archive,
        cwd: staging,
        strip: 1,
        strict: true,
        filter: (name) =>
          name.endsWith("/bin/node") || name.endsWith("/LICENSE"),
      });
      await chmod(path.join(staging, "bin", "node"), 0o755);
      await rename(
        path.join(staging, "bin", "node"),
        path.join(runtime, "node"),
      );
      await copyFile(
        path.join(staging, "LICENSE"),
        path.join(runtime, "node-runtime-LICENSE"),
      );
    }
    const metadataPath = path.join(root, "runtime", "openvscode-runtime.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.nodeRefresh = {
      version,
      asset: spec.asset,
      sha256: spec.sha256,
      source: url,
    };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
    console.log(
      "Updated bundled Node to " +
        version +
        " for " +
        target +
        " after official SHA256 verification.",
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
async function download(url, maximum) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body)
    throw new Error("Runtime download failed: " + response.status);
  if (Number(response.headers.get("content-length") ?? 0) > maximum)
    throw new Error("Runtime asset exceeds size limit");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maximum) throw new Error("Runtime asset exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
