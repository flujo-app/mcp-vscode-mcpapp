# Manual host test matrix

This matrix verifies the genuine-workbench rendering contract described in the [README](../README.md). It complements the automated selection, gateway, broker, and system-browser tests; it does not replace testing against real host builds.

## Non-negotiable acceptance rule

Every successful editor view must be the real OpenVSCode workbench:

- `embedded` displays the workbench document directly in an iframe;
- `stream` displays frames captured from that workbench by server-side Chromium; and
- `browser` opens that same workbench in a separate tab.

There is no alternate editor shell. A blocked, unreachable, or failed workbench must produce a visible explanation, never a blank view and never a substitute product.

## Common functional pass

For every successful `embedded`, `stream`, or opened `browser` view, verify:

1. **Identity**—the OpenVSCode command palette, activity bar, source-control view, extensions view, settings UI, and status bar are present. This is the quickest guard against accidentally testing an imitation.
2. **Browse**—the Explorer lists files from the configured workspace only.
3. **Open and edit**—open a file, change it in the visible editor, and confirm `editor_state` sees the same document and dirty state through the real bridge.
4. **Selection**—change the visible selection and verify the bridge reports the same range.
5. **Save**—save, confirm the bytes on disk, and verify a deliberate stale write produces `VERSION_CONFLICT` rather than overwriting silently.
6. **Diagnostics**—introduce a supported-language error and confirm `diagnostics_get` returns the workbench diagnostic.
7. **Commands and extensions**—list commands and extensions; exercise a safe command. Confirm these calls fail explicitly if the bridge is intentionally disconnected.
8. **Terminal**—create a terminal, run a harmless command, and observe output in both the visible workbench and MCP tools.
9. **Workbench-only UI**—open a Markdown preview or another webview-capable feature where supported.
10. **Recovery**—press Reload after a controlled failure and confirm the App either re-establishes the requested real renderer or repeats the honest failure.

For `stream`, additionally verify mouse movement, single/double click, right click, wheel scrolling, common keyboard shortcuts, typing, paste, resize, and fullscreen. Record clipboard-copy and IME limitations rather than treating them as complete.

## Host and deployment rows

Host behavior can change. Record the exact host version, OS, mcp-vscode commit/package version, and date for each run.

| Host/deployment | Configuration | Expected App result | What this row proves |
| --- | --- | --- | --- |
| FLUJO local, framing approved | Default (`MCP_VSCODE_RENDER_MODE` unset) | `embedded` | FLUJO returns the declared origin in effective `frameDomains`; the positive liveness message commits the genuine iframe. |
| FLUJO local, frame grant deliberately removed | Default | `browser` with a frame-policy explanation | An explicit host denial skips iframe navigation and never reveals a blank or substitute editor. Opening the link reaches genuine OpenVSCode. |
| Claude Desktop local stdio, current observed policy | Default | `browser` | Re-check the behavior in the [upstream report](upstream-frame-domains-report.md): loopback network grants work but the loopback frame grant is absent. The result must be honest rather than silently changing products. |
| Claude Desktop local stdio with system Edge/Chrome/Chromium | `MCP_VSCODE_RENDER_MODE=stream` | `stream` if the host preserves tool-result `_meta` and permits the declared loopback WebSocket; otherwise an explicit `browser` error | Tests the genuine streamed workbench without `frameDomains`. Verify the status badge says experimental streaming and inspect the canvas pixels for real workbench UI. |
| FLUJO hosted on Fly, default | Broker capability injected by FLUJO; render mode unset | `embedded` | The one-use registration publishes a browser-reachable per-App HTTPS origin; HTTP and WebSocket traffic under the random `/ide/<key>` prefix reaches the private Machine. |
| FLUJO hosted on Fly, streaming | Broker capability plus `MCP_VSCODE_RENDER_MODE=stream`; Chromium and a non-root `node` account installed in the image | `stream` | The broker exposes exact WebSocket `/stream`, TLS becomes WSS, and frames/input cross the public route. A root MCP process drops only Chromium to `node`; no public random Machine port or visitor-side loopback URL is used. |
| Plain `/app` debug page in a browser | Default | `embedded` | The gateway's debug session payload and direct workbench proxy operate without an MCP host policy in between. |
| Plain `/app` debug page in a browser | `MCP_VSCODE_RENDER_MODE=stream` | `stream` | System-browser discovery, CDP startup, JPEG decoding, input, and clean teardown work end to end. |
| Any supported host, OpenVSCode runtime missing or forced to exit | Either mode | Visible runtime error; no editor | All UI modes depend on genuine OpenVSCode. There is no runtime-independent facsimile. |
| Any supported host, streaming browser path invalid | `MCP_VSCODE_RENDER_MODE=stream` and invalid `MCP_VSCODE_STREAM_BROWSER` | `browser` card containing the browser-unavailable reason | Streaming fails honestly and does not fall through to an unrequested editor implementation. |
| Any supported host, `/stream` proxy does not upgrade | Stream mode | Connection error followed by honest `browser` fallback | Fly/reverse-proxy routing is a separate requirement from MCP CSP metadata. |
| macOS without an external compatible OpenVSCode runtime | Either mode | Runtime unavailable; no editor | A system Chromium alone cannot replace the missing OpenVSCode Server runtime. |
| Other MCP Apps host | Default first; stream in a separate run | Determined by its effective frame/network grants | Do not infer behavior from the server declaration alone. Capture the host-reported CSP and the actual probe outcome. |

## FLUJO/Fly infrastructure checks

Before judging the App renderer, verify the road from the visitor's browser to the private runtime:

- The user-facing FLUJO site loads normally while the MCP App uses its separate sandbox/per-App origins behind the scenes.
- Wildcard DNS and TLS cover the per-App origin scheme.
- The managed child receives both one-use broker environment variables together.
- Registration validates the resource identity and returns a public `https:` origin.
- The published allowlist contains the current random `/ide/<key>` prefix with HTTP and WebSocket support.
- `/stream` is published as an exact WebSocket route only when streaming is enabled.
- Public requests cannot reach `/mcp`, `/bridge`, `/healthz`, `/app`, `/session.json`, or the temporary proof path through the App runtime proxy.
- Reverse-proxy logs show a WebSocket upgrade rather than polling, redirect loops, or a `200` HTML response for socket requests.
- `Host`, `Origin`, `Referer`, request path/query, and Upgrade headers survive the proxy chain as intended.
- No session payload advertises a private Machine address or visitor-side `127.0.0.1` URL in hosted mode.

For stream mode on Fly:

- `MCP_VSCODE_STREAM_BROWSER` resolves inside the Machine, or normal discovery finds the executable.
- Chromium runs with an ephemeral profile and a loopback-only DevTools listener.
- Prefer an unprivileged container user and the Chromium sandbox. When mcp-vscode runs as POSIX uid 0, verify `/etc/passwd` contains exactly one `node` account with non-zero uid/gid; `/tmp` is root-owned, traversable, and sticky if group/world-writable; the high-entropy profile beneath it is owned by `node`; and only the Chromium process tree runs under that identity.
- Verify the Chromium child receives profile-local `HOME`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_RUNTIME_DIR` values and starts with the isolated home as its working directory.
- Remove or corrupt the `node` entry and confirm streaming fails visibly with guidance; it must not silently add `--no-sandbox`. If a test explicitly requires `MCP_VSCODE_STREAM_NO_SANDBOX=1`, record that as a security exception.
- Measure CPU, memory, outbound bandwidth, frame rate, and input latency with a realistic workspace. A functional test alone is not a capacity result.

## Security and secret checks

- A connection to `/stream` without its independent token, or with the wrong token, is rejected.
- A second simultaneous stream viewer is rejected.
- The tokenized stream URL is absent from model-visible tool text and `structuredContent`; it appears only in App-facing result `_meta` or the authenticated debug session.
- The high-entropy `/ide/<key>` capability URL is likewise absent from model-visible output and appears only in App-facing result `_meta` or the same-origin debug session.
- Application logs, browser console logs, and error cards do not print the stream token or unredacted `/ide/<key>` URL. Configure any reverse-proxy/edge access log to redact capability-bearing paths as well.
- Stream input cannot request navigation or arbitrary DevTools methods.
- DevTools is not externally reachable, even when the gateway is public.
- On a root POSIX server with sandboxing enabled, Chromium and its renderer children have the `node` uid/gid while mcp-vscode and OpenVSCode keep their configured identities.
- Closing the viewer/server or crashing Chromium removes the ephemeral profile and releases child processes.

## Failure-injection checks

Exercise these independently so one failure does not hide another:

- remove the effective frame-domain grant;
- block workbench HTTP;
- block the workbench WebSocket while leaving HTTP reachable;
- suppress the liveness message;
- block `/stream` WebSocket upgrade;
- remove all discoverable Chromium executables;
- remove the safe `node` account while launching sandboxed streaming as root;
- crash Chromium after the first frame;
- crash OpenVSCode after the bridge connects;
- restart the gateway with a different origin; and
- strip custom tool-result `_meta` in a test host.

For each failure, record the status badge, user-facing reason, console errors, cleanup behavior, and whether **Open in browser** reaches the genuine workbench.

## Test record template

```text
Date/time:
Host + exact version:
OS / deployment:
mcp-vscode version or commit:
Render environment variables:
Advertised gateway origin:
Host-reported frame/connect/resource grants:
Committed result: embedded | stream | browser | runtime error
Common functional pass:
Stream input pass (if applicable):
Failure injected:
Observed fallback and reason:
HTTP/WS proxy evidence:
CPU / memory / bandwidth / latency (stream on hosted deployments):
Secrets or cleanup issues:
Notes:
```
