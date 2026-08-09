# Upstream report draft — local stdio `frameDomains` is not reflected in the effective sandbox CSP

**Proposed target:** `anthropics/claude-code#59351`

**Status:** DRAFT ONLY. This repository does not post, schedule, or automate this report. Before posting, a maintainer must re-run the reproduction against the current Claude Desktop release, record its exact version and OS, and update any implementation details that changed.

---

## Summary

In the Claude Desktop build we tested, an MCP App served by a locally configured stdio connector could use its declared loopback `connectDomains` and `resourceDomains`, but the same server's declared loopback `frameDomains` was absent from the sandbox's effective `frame-src` policy.

The practical result was:

- `fetch` and WebSocket connections to the declared `http://127.0.0.1:<port>` / `ws://127.0.0.1:<port>` gateway succeeded;
- resources from that declared loopback origin succeeded; but
- an iframe pointed at the server's genuine OpenVSCode URL was blocked by the outer sandbox CSP.

The MCP server cannot repair that decision with CORS, response headers, redirects, or a different iframe attribute. The outer host constructs the sandbox policy. A server declaration asks the host for permission; it does not override the host.

This may be an intentional host policy rather than a protocol-parser bug. The actionable problem is that a local connector receives no clear signal explaining that its requested frame origin was declined, while the other requested domain classes work. From inside the App, a CSP-blocked iframe may produce neither a useful `load` nor `error` event, so denial looks like an indefinitely slow page.

## Minimal reproduction

Use a local stdio MCP server that:

1. starts an HTTP/WebSocket gateway on an ephemeral loopback port;
2. returns a `text/html;profile=mcp-app` resource;
3. declares the gateway origin in `_meta.ui.csp.frameDomains`, `connectDomains`, `resourceDomains`, and `baseUriDomains`;
4. has the App perform a `fetch` and open a WebSocket to the gateway; and
5. has the App create an iframe whose URL is on that same gateway origin.

Expected if the requested local origin is approved:

- the network checks succeed; and
- the iframe document is permitted by `frame-src` and reports a positive liveness message.

Observed in the tested Claude Desktop build:

- network/resource checks succeed;
- the loopback origin appears in the effective network/resource allowances;
- it does not appear in the effective frame allowance; and
- browser CSP enforcement blocks the iframe before the child document can report liveness.

The reproduction should record the host's `ui/initialize` capabilities, the final sandbox CSP, the App console's CSP error, and whether the iframe generates any observable event.

## Evidence from the tested build

- Changing `connectDomains` and `resourceDomains` changed the corresponding host-generated sandbox allowances, and the App could demonstrate those grants with real traffic.
- Changing the local connector's `frameDomains` did not add the loopback origin to the effective `frame-src` policy.
- Inspection of the tested renderer bundle indicated that its frame allowance came from a host-side approved-domain list associated with reviewed/directory connectors, rather than directly from the local server declaration.
- `baseUriDomains` also appeared not to affect the tested local connector path.

These are observations about one tested implementation, not assumptions the report should project onto future releases. If the current build now returns an effective frame grant or a clear denial signal, this draft should be updated or closed.

## Why this matters

The MCP App in this reproduction is not trying to frame an unrelated third party. It is trying to display the OpenVSCode runtime started by the same user-approved local connector on that connector's own loopback gateway.

Without a frame grant, the choices are materially worse:

- open the genuine workbench in a separate browser tab;
- run an expensive remote-display stream through the already-approved network channel; or
- show an explicit unsupported-policy message.

Building a lookalike editor is not an acceptable compatibility solution because it changes the product while preserving its name.

## Requested behavior

Either outcome below would make the integration deterministic.

### Preferred: support an approved local frame origin

Allow a locally configured, user-approved stdio connector's declared loopback `frameDomains` origin to enter the effective sandbox `frame-src` policy, subject to whatever explicit host/user approval Anthropic considers appropriate.

This request is narrow:

- same local connector;
- loopback HTTP(S) origin started for that connector;
- origin declared in the MCP App resource metadata; and
- no request for arbitrary remote third-party framing.

### Minimum: report the effective denial

If local nested frames are intentionally unsupported, expose that decision clearly to the App. Possibilities include:

- returning the effective approved frame-domain set in host capabilities;
- omitting denied values from an explicit effective-CSP result;
- emitting a host diagnostic; or
- documenting and surfacing a stable "local frame domains unsupported" capability.

The important property is that the App can distinguish policy denial from network latency without waiting for a blind timeout.

## What this report is not asking for

- It does not ask local connectors to receive directory/review status.
- It does not ask the server to bypass the host sandbox.
- It does not ask for wildcard or arbitrary remote framing.
- It does not claim the server's CSP declaration must be accepted unconditionally; hosts may enforce stricter policy.
- It does not ask Anthropic to support mcp-vscode's experimental streaming mode.

## Current mcp-vscode behavior

mcp-vscode now preserves the product boundary:

- In default mode it attempts to display the genuine OpenVSCode iframe only when the host has not explicitly denied the origin, and commits it only after a positive liveness message.
- If the host declines or silently blocks the frame, it shows an honest browser fallback and the reason. It does not substitute another editor.
- An administrator may explicitly set `MCP_VSCODE_RENDER_MODE=stream`. In that experimental mode, server-side Edge/Chrome/Chromium renders the genuine workbench and an authenticated WebSocket carries JPEG frames and bounded input. This uses the network grant rather than a nested browsing context.

Streaming is a mitigation, not resolution of the host issue. It adds a system-browser prerequisite, CPU/bandwidth cost, latency, a one-viewer limit, and incomplete clipboard/IME behavior. It also still requires a browser-reachable WebSocket route. Default inline OpenVSCode should not require those costs merely because the workbench belongs to a local stdio connector.

See [How the editor renders](../README.md#rendering-modes) and the [manual host matrix](manual-test-matrix.md) for the current behavior and retest procedure.

## Information to add before posting

```text
Claude Desktop version:
Operating system and version:
MCP Apps protocol / ext-apps version where visible:
Exact server CSP declaration:
Host-reported effective CSP/capabilities:
Sandbox CSP excerpt:
Browser console CSP error:
Network fetch result:
WebSocket result:
Iframe/liveness result:
Minimal reproduction repository or attachment:
```
