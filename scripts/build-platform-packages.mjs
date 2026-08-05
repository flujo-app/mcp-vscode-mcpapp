// Stage a per-platform npm runtime package from the runtime currently installed
// in `runtime/`. Each package carries exactly one OpenVSCode server build and is
// gated with `os`/`cpu` so npm only installs the one matching the host.
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TARGETS = {
  "win32-x64": {
    os: "win32",
    cpu: "x64",
    probe: ["node.exe", "out/server-main.js", "bin/openvscode-server.cmd"],
  },
  "linux-x64": {
    os: "linux",
    cpu: "x64",
    probe: ["node", "out/server-main.js", "bin/openvscode-server"],
  },
  "linux-arm64": {
    os: "linux",
    cpu: "arm64",
    probe: ["node", "out/server-main.js", "bin/openvscode-server"],
  },
};

const requested = process.argv[2];
const target = TARGETS[requested];
if (!target) {
  throw new Error(`Platform runtime packages support: ${Object.keys(TARGETS).join(", ")}`);
}

const projectRoot = path.resolve(process.cwd());
const runtimeRoot = path.join(projectRoot, "runtime", "openvscode-server");
const metadataPath = path.join(projectRoot, "runtime", "openvscode-runtime.json");
const rootManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));

// The runtime on disk must be the one we claim to be shipping. Getting this wrong
// would publish e.g. a Linux server under the win32 package and break every install.
if (metadata.target !== requested) {
  throw new Error(
    `runtime/ holds target ${JSON.stringify(metadata.target)}, refusing to stage the ${requested} package. ` +
      `Run the fetch/build step for ${requested} first.`,
  );
}

for (const relative of target.probe) {
  await access(path.join(runtimeRoot, ...relative.split("/")));
}
// node-pty is a native module and cannot be compiled at install time on user
// machines, so every platform package must carry its own prebuilt copy.
await access(path.join(runtimeRoot, "node_modules", "node-pty", "package.json"));

const packageName = `${rootManifest.name}-${requested}`;
const outRoot = path.join(projectRoot, "platform-packages");
const out = path.join(outRoot, requested);
if (path.dirname(outRoot) !== projectRoot) throw new Error(`Unsafe platform package path: ${outRoot}`);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const manifest = {
  name: packageName,
  version: rootManifest.version,
  description: `OpenVSCode ${metadata.version} runtime for ${requested}, used by ${rootManifest.name}.`,
  license: rootManifest.license,
  author: rootManifest.author,
  repository: rootManifest.repository,
  homepage: rootManifest.homepage,
  engines: rootManifest.engines,
  publishConfig: { access: "public" },
  os: [target.os],
  cpu: [target.cpu],
  // No "exports" field: the dispatcher resolves `<pkg>/package.json` to find this
  // package's directory, which legacy subpath resolution allows unconditionally.
  files: ["runtime", "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"],
};
await writeFile(path.join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

await mkdir(path.join(out, "runtime"), { recursive: true });
await cp(runtimeRoot, path.join(out, "runtime", "openvscode-server"), { recursive: true });
await cp(metadataPath, path.join(out, "runtime", "openvscode-runtime.json"));
for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(path.join(projectRoot, file), path.join(out, file));
}
await writeFile(
  path.join(out, "README.md"),
  `# ${packageName}\n\n` +
    `Prebuilt OpenVSCode Server ${metadata.version} runtime for \`${requested}\`.\n\n` +
    `This package is an implementation detail of [\`${rootManifest.name}\`](${rootManifest.homepage}).\n` +
    `Install that package instead; npm selects the correct runtime for your platform automatically.\n`,
);

console.log(`Staged ${packageName}@${manifest.version} in ${out}`);
