mcp-vscode-mcpapp in [FLUJO](https://flujo.com.co/)
<img width="1096" height="597" alt="image" src="https://github.com/user-attachments/assets/f6860467-9957-4fd4-975c-96484c0f6ea8" />

mcp-vscode-mcpapp in Goose
<img width="1816" height="1080" alt="image" src="https://github.com/user-attachments/assets/07cba92c-48d0-47cc-b1bc-978410156e30" />


# MCP VS Code

MCP VS Code embeds a self-hosted Code OSS/OpenVSCode workbench inside an MCP App. The model and the human operate the same workspace, open editors, diagnostics, commands, and terminal sessions in real time.

This is not remote control of a separately installed VS Code. The standalone distribution contains the editor server, Node.js runtime, MCP server, bridge extension, and web UI. Microsoft-hosted `vscode.dev` is not used because it disallows framing.

> **Project status:** functional v0.1 implementation. Prerequisite-free releases target Windows x64, Linux x64, and Linux ARM64. Linux packages use verified upstream OpenVSCode archives; the Windows package is built in Windows CI from the pinned OpenVSCode source commit and exercised against the real workbench and bridge.

## How it works

```mermaid
flowchart LR
    H["MCP host"] <-->|"stdio or Streamable HTTPS"| S["MCP VS Code server"]
    H --> A["Sandboxed MCP App view"]
    A -->|"nested iframe on an allowed frameDomain"| V["Bundled OpenVSCode workbench"]
    S --> W["Confined workspace"]
    S --> T["Shared PTYs"]
    V <-->|"authenticated local WebSocket"| B["Bridge extension"]
    B <--> S
    V --> W
    B --> T
```

The OpenVSCode process binds only to loopback. A gateway exposes it under a random, high-entropy path, avoiding third-party-cookie authentication inside the MCP sandbox. Remote MCP deployments must use TLS and bearer authentication.

## Gateway HTTP surface

The same HTTP(S) server used for `/mcp` also exposes:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Liveness probe. |
| `GET /session.json` | `?token=` (if `--auth-token` set) | JSON session payload (workspace, OpenVSCode, bridge, `uiToken`, `assetsUrl`). |
| `GET /app` | `?token=` (if `--auth-token` set) | The MCP App HTML shell. |
| `ALL /mcp` | `Authorization: Bearer` (if `--auth-token` set) | Streamable HTTP MCP transport. |
| `GET /assets/*` | none (public, read-only, static bundle) | Monaco/xterm/UI bundle for a future native renderer. Reachable even before OpenVSCode finishes starting. |
| `GET /ide/<random>/...` | none beyond the unguessable path | Proxied OpenVSCode workbench. |
| `WS /bridge` | first-message `{ type: "hello", token }` | The VS Code bridge extension's JSON-RPC channel. |
| `WS /ui` | `?token=` query parameter | Direct JSON-RPC channel (same framing as `/bridge`) for workspace/terminal/editor operations, bypassing the VS Code extension. Loopback-only, single client, reuses the same `bridgeToken` — see [SECURITY.md](SECURITY.md). |

`uiToken` in the session payload is currently identical to the bridge token (one shared secret, zero new configuration, per the design in issue #6). `assetsUrl` is `${gatewayOrigin}/assets`.

## Capabilities

- Self-hosted Code OSS workbench rendered inside the MCP App sandbox.
- Human editing, navigation, source control, commands, extensions, and terminal interaction.
- Live editor state, selections, dirty buffers, diagnostics, and file changes visible to MCP tools.
- Shared terminal sessions using the target-native PTY bundled with OpenVSCode, with a pipe-based fallback.
- Workspace confinement with traversal and symlink-escape protection.
- Conflict-safe file writes using SHA-256 version tokens.
- stdio and Streamable HTTP/HTTPS transports from the same executable.
- Generic `vscode_execute_command` escape hatch for every command registered in the live workbench.

The server currently exposes 27 tools across these groups:

| Group | Tools |
| --- | --- |
| App/session | `vscode_open`, `workspace_status` |
| Files | `fs_list`, `fs_read`, `fs_write`, `fs_delete`, `fs_move`, `fs_search` |
| Editor | `editor_open`, `editor_state`, `editor_set_selection`, `editor_apply_edits` |
| Language services | `diagnostics_get` |
| Commands | `vscode_list_commands`, `vscode_execute_command` |
| Extensions | `extensions_list`, `extensions_install`, `extensions_uninstall` |
| Terminals | `terminal_create`, `terminal_list`, `terminal_read`, `terminal_write`, `terminal_resize`, `terminal_kill` |
| Git | `git_status`, `git_diff`, `git_run` |

Destructive and open-world tools are annotated accordingly so compatible MCP hosts can apply their approval policy.

## Install a standalone release

Download and extract the release archive for your platform.

Windows x64:

```powershell
.\bin\mcp-vscode.cmd --stdio --workspace C:\path\to\repository
```

Linux x64 or ARM64:

```bash
./bin/mcp-vscode --stdio --workspace /absolute/path/to/repository
```

The archive contains its own Node.js and OpenVSCode runtimes. It does not require VS Code, Node.js, Docker, or a system-wide package installation.

## Run from npm

With Node.js 22 or newer, `npx` starts the bundled stdio server on Windows x64, Linux x64, and Linux ARM64:

```powershell
npx -y @mario.andreschak/mcp-vscode@0.1.8 --stdio --workspace "C:\path\to\repository"
```

```bash
npx -y @mario.andreschak/mcp-vscode@0.1.8 --stdio --workspace "/path/to/repository"
```

For MCP clients that configure the workspace through an environment variable:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "npx",
      "args": ["-y", "@mario.andreschak/mcp-vscode@0.1.8", "--stdio"],
      "env": {
        "MCP_VSCODE_WORKSPACE": "C:\\path\\to\\repository"
      }
    }
  }
}
```

Pin the workspace explicitly. With neither `--workspace` nor `MCP_VSCODE_WORKSPACE`, the server falls back to the working directory it was spawned in and reports that fallback on stderr. Hosts that spawn MCP servers from a mounted volume root (for example `/data` on Fly.io) would otherwise expose that whole volume as the workspace, including root-owned entries such as `lost+found`. Such entries are ignored, and a directory the server may not read no longer aborts startup, but an explicit workspace keeps the file watcher scoped to the repository you meant.

`@mario.andreschak/mcp-vscode` itself contains no editor runtime. It declares one `optionalDependencies` entry per supported platform — `@mario.andreschak/mcp-vscode-win32-x64`, `-linux-x64`, and `-linux-arm64` — each gated by `os`/`cpu`, so npm downloads only the OpenVSCode runtime matching the host. macOS is not supported: upstream publishes no darwin server build.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "/opt/mcp-vscode/bin/mcp-vscode",
      "args": ["--stdio", "--workspace", "/work/my-repository"]
    }
  }
}
```

Calling `vscode_open` renders the workbench. The app requests fullscreen mode when the user selects **Fullscreen**.

## Run over HTTPS

```bash
./bin/mcp-vscode \
  --http \
  --https \
  --host 0.0.0.0 \
  --port 8443 \
  --workspace /work/my-repository \
  --public-url https://editor.example.com:8443 \
  --auth-token "$MCP_VSCODE_TOKEN" \
  --cert /run/secrets/tls.crt \
  --key /run/secrets/tls.key
```

The MCP endpoint is `https://editor.example.com:8443/mcp`. Binding beyond loopback is rejected unless both TLS and a bearer token are configured.

## MCP host requirements

The host must support the stable MCP Apps extension `io.modelcontextprotocol/ui` and:

- `text/html;profile=mcp-app` resources;
- the declared `frameDomains`, `connectDomains`, and `resourceDomains`;
- nested iframe scripts, workers, WebSockets, and same-origin behavior;
- a sufficiently large inline container or fullscreen display mode.

If a host blocks the OpenVSCode frame, the app displays the exact runtime or policy error instead of silently opening an external browser tab.

## Build from source

Requirements for development only: Node.js 22+.

```bash
npm ci
npm run check
```

Useful commands:

```bash
npm run dev -- --http --port 3001 --workspace . --ide-url http://127.0.0.1:3999
npm run dev:mock-ide -- --port 3999
npm run runtime:fetch -- linux-x64
npm run runtime:build -- win32-x64
npm run package:standalone -- linux-x64
npm run package:standalone -- win32-x64
npm run npm:platform-package -- linux-x64
```

`npm run npm:platform-package -- <target>` stages the publishable runtime package for one platform in `platform-packages/<target>/`, using whichever runtime is currently installed in `runtime/`. It refuses to run when `runtime/openvscode-runtime.json` reports a different target, so a Linux runtime can never be published under the Windows package. `npm run npm:prepare-manifest` stages the platform-neutral dispatcher manifest that pins those packages, and `npm run npm:verify-runtime` asserts the dispatcher stays free of `os`/`cpu` gates and of the bundled `runtime` directory.

The runtime fetcher pins OpenVSCode `1.109.5` and verifies upstream Linux SHA-256 digests before extraction. Native Windows builds pin and verify upstream commit `4ffe2270acdf711bbefecc3e8c79f4b3631640e5`, then invoke Code OSS's `vscode-reh-web-win32-x64` build target. Building that runtime locally requires Windows x64, Git, Node.js 22.21.1 or newer, and the Visual Studio 2022 C++ build tools with `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre`. Release archives contain the resulting runtime and do not require those development tools. Runtime and standalone output directories are ignored by Git.

## Publish a release to npm

Release CI publishes automatically once the `NPM_TOKEN` secret and the `npm-publish` environment are configured. To publish by hand instead — for example when the account requires an interactive passkey — download the `*.npm.tgz` assets and their `.sha256` sidecars from the GitHub Release into `release-artifacts-v<version>/`, then run:

```bash
npm run npm:publish -- release-artifacts-v0.1.8 --dry-run   # verify only, upload nothing
npm run npm:publish -- release-artifacts-v0.1.8             # publish
```

Authentication happens **in the same terminal**: when no npm session exists, the publish script hands the terminal to `npm login --auth-type=web`, which prints a URL and opens the browser for passkey / WebAuthn sign-in, then resumes publishing once the session is stored. Nothing else is required.

```bash
npm run npm:whoami                                          # check the current identity
npm run npm:login                                            # sign in ahead of time (optional)
npm run npm:publish:wait -- release-artifacts-v0.1.8         # don't log in here; poll for a login from another terminal
npm run npm:publish -- release-artifacts-v0.1.8 --no-login   # fail fast when no session exists (CI / token auth)
```

`npm run npm:publish` verifies every tarball before asking for credentials, so a bad artifact set fails before any browser opens. It publishes the three runtime packages before the dispatcher that pins them, skips versions already on the registry so an interrupted run can simply be re-run, and refuses to upload a tarball whose internal `package.json` disagrees with the name and version its filename claims. It never builds a tarball: the published bytes are exactly the audited release artifacts.

## Publish to the MCP Registry

The [MCP Registry](https://modelcontextprotocol.io/registry/quickstart) stores metadata only, so the npm packages must be live **before** this step:

```bash
npm run mcp:validate    # check server.json + npm state, download nothing else, publish nothing
npm run mcp:publish     # log in if needed, then publish server.json
```

`npm run mcp:publish` (`scripts/publish-mcp.mjs`) works through the quickstart steps in order, and refuses to continue if any of them is off:

- `server.json` and `package.json` must agree — `mcpName` versus `name`, and one shared version across `package.json`, `server.json` and its npm package entry.
- `@mario.andreschak/mcp-vscode@<version>` must already be on npm, and the **published** package must declare the matching `mcpName`. That mismatch is what produces the registry's "Registry validation failed for package", so it is checked against the registry copy rather than the working tree.
- With GitHub authentication the server name must start with `io.github.<user>/`, which is verified before a browser opens.
- The registry JWT that GitHub login mints carries the namespaces it may publish (`io.github.<authorized-account>/*`). That claim is compared with `server.json`'s name **before** the upload, because the device flow silently authorizes whichever account your browser happens to be signed in as — publishing `io.github.mario-andreschak/...` with, say, the `flujo-app` account can only ever return 403, and no amount of re-authenticating fixes it.
- Versions already listed in the registry are skipped (registry versions are immutable); pass `--force` to attempt the upload anyway.
- The pinned `mcp-publisher` 1.8.0 binary is downloaded into `.tools/` (git-ignored) and verified against a recorded SHA-256 digest — no Homebrew, `curl | tar` pipeline or Go toolchain needed. Set `MCP_PUBLISHER_BIN` to use your own build.
- `mcp-publisher validate` runs first, so a malformed `server.json` fails before authentication.

Authentication again happens **in the same terminal**: the GitHub device-code flow prints a URL and a code, and publishing continues automatically once you approve it. A saved registry token is reused while it is still valid (they live only ~5 minutes), and an *expired* token triggers one silent re-login and retry. A *permission* failure never does — it aborts with the authorized identity and its granted namespaces, so the script can no longer appear to hang at `Waiting for authorization...` behind a second device code nobody was told to enter.

To publish as a specific account without fighting the browser session, hand the flow a personal access token (scopes `read:user`, `read:org`):

```powershell
$env:MCP_GITHUB_TOKEN = "<pat of the namespace owner>"; npm run mcp:publish
```

```bash
npm run mcp:publish -- --login github-oidc                       # GitHub Actions OIDC
npm run mcp:publish -- --login dns --domain example.com --private-key <hex>
npm run mcp:publish -- --relogin                                 # force a fresh login
npm run mcp:publish -- --token <github-pat>                       # skip the device flow, publish as that account
npm run mcp:publish -- --no-login                                # require an existing token, never prompt
npm run mcp:publish -- --registry http://localhost:8080          # publish against a local registry
```

Verify a publish with `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.mario-andreschak/mcp-vscode"`.

## Security model

- Every file path is resolved beneath one configured workspace root. Existing symlinks are canonicalized before access.
- The workspace root cannot be deleted through MCP tools.
- OpenVSCode listens on loopback and is exposed through an unguessable per-process path.
- The bridge uses a separate 256-bit token and accepts one active bridge connection.
- Remote listeners require HTTPS and bearer authentication.
- Git hooks are disabled for `git_run`; arbitrary VS Code commands and shell input remain powerful and should require host approval.
- Unsaved text documents up to 2 MB are mirrored into the MCP-visible overlay. Larger dirty documents remain available through editor commands but are not copied on every keystroke.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Upstream and trademarks

OpenVSCode Server and Code OSS are MIT-licensed upstream projects. MCP VS Code is independent and is not affiliated with or endorsed by Microsoft or Gitpod. “Visual Studio Code” and “VS Code” are trademarks of Microsoft Corporation.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
