# Upstream report draft — `frameDomains` silently dropped for local stdio connectors

**Target:** `anthropics/claude-code#59351`

**Status:** DRAFT ONLY. This file is not posted anywhere by this change. A maintainer must
review it and post it manually to the linked issue (or open a new one if that issue has
since been closed/redirected). Nothing in this repository automates or schedules that post.

---

## Summary

Claude Desktop's MCP App host (the sandboxed iframe/CSP layer for `text/html;profile=mcp-app`
resources) forwards two of the three domain lists declared in a server's `_meta.ui.csp`, but
silently drops the third:

- `_meta.ui.csp.connectDomains` → forwarded into the sandbox document's `?connect-src=`
  query parameter. **Confirmed working**: our declared `http://127.0.0.1:<port>` and
  `ws://127.0.0.1:<port>` origins round-trip and our WebSocket/`fetch` calls succeed.
- `_meta.ui.csp.resourceDomains` → forwarded into `?resource-src=`. **Confirmed working**:
  images/scripts/styles/fonts/media loaded from our declared loopback origin succeed.
- `_meta.ui.csp.frameDomains` → **not forwarded anywhere**. Reverse-engineering the host's
  renderer bundle shows `frame-src` in the generated sandbox CSP is populated *exclusively*
  from a host-side `approvedFrameDomains` prop. That prop is only populated for
  directory-listed remote connectors (servers registered in Anthropic's connector
  directory with a stable, pre-approved domain) — it is never derived from a locally
  configured (stdio) server's own `_meta.ui.csp.frameDomains` declaration.
- `_meta.ui.csp.baseUriDomains` similarly appears to have no effect for local connectors.

**Practical effect:** a locally configured MCP server that declares `frameDomains` for its
own loopback origin (as ours does, for its `ideUrl`) always ends up with a sandbox CSP of
`frame-src 'self' blob: data:` — the loopback origin is never added — so any `<iframe>`
pointed at that origin is blocked by the browser's own CSP enforcement inside the sandbox
document. There is no error surfaced to the MCP App itself: a CSP-blocked iframe fires
neither `load` nor `error`, so from inside the sandbox this looks indistinguishable from "the
iframe is just slow", not "this will never load".

## Why we are reasonably confident about the mechanism

- `connectDomains` and `resourceDomains` visibly change host-generated query parameters
  (`connect-src=`, `resource-src=`) on the sandbox document URL, which we can observe from
  our own served pages. `frameDomains` produces no equivalent parameter change under any
  value we have tried.
- The only CSP source we can find for `frame-src` in the renderer bundle is
  `approvedFrameDomains`, which is wired to directory metadata, not to anything in the
  per-connection `_meta.ui.csp` the server sends over MCP.
- We worked around this by building an entirely separate, framing-free rendering tier: our
  MCP App renders Monaco/xterm directly in its own sandboxed document and talks to our
  gateway process purely over the already-forwarded `connect-src`/`resource-src` grants (an
  authenticated WebSocket plus a static asset bundle). That workaround succeeds precisely
  because it needs no `frame-src` grant at all — which is itself evidence that `frame-src`
  is the one channel that is not honoring our declaration.

## What we are asking for

Either of the following would resolve the underlying gap (in order of preference):

1. **Honour server-declared `frameDomains` for loopback origins of locally configured
   servers.** A locally spawned stdio server's `_meta.ui.csp.frameDomains` entry pointing at
   its own loopback origin is inherently as trustworthy as its `connectDomains`/
   `resourceDomains` entries already are (same server, same connection, same trust
   boundary) — there is no additional third party being granted framing rights.
2. **At minimum, warn instead of silently dropping.** If honouring `frameDomains` for local
   connectors is not desired for other reasons, surface that decision to the server (e.g. via
   a diagnostic/log channel, or by omitting the field from whatever confirms other grants)
   rather than accepting the declaration and then not acting on it. The silent drop is what
   makes this expensive to diagnose: from the server's side, everything it declared appears
   accepted.

## What we are *not* asking for

- We are not asking for `approvedFrameDomains` / directory-listing status for local
  connectors — the existing behaviour there (reserved for reviewed, stable, directory-listed
  domains) is reasonable as a default-deny for framing an *arbitrary remote* origin. This
  report is specifically about the narrower case of a server's *own* loopback origin, which
  is not a third-party framing request.
- We are not asking for any change to how `_meta.ui.csp` is declared or shaped on our end;
  our declaration already includes `frameDomains` today (and will keep doing so — it costs
  nothing when dropped, and is honoured correctly by spec-compliant hosts).

## Our current mitigation (already shipped, not blocked on this report)

We no longer depend on this behaviour changing. MCP VS Code auto-selects a rendering tier at
runtime — `native` (Monaco/xterm rendered directly, needs only `connectDomains` +
`resourceDomains`) → `embedded` (the iframe strategy this report is about) → `browser` (an
`openLink` fallback) — with no configuration required. See the README's "How the editor
renders" section and `src/app/tier.ts`. This report exists so the underlying host behaviour
is documented upstream, not because our own functionality depends on the fix.
