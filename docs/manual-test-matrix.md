# Manual host test matrix

This matrix accompanies the "How the editor renders" section of the [README](../README.md)
and the automated tier-permutation harness (`tests-integration/`). It records the manual,
real-host verification pass for issue #10 (epic: render an editor in every MCP host) §4.3.

Tier selection is fully automatic (see `src/app/tier.ts`); there is no flag or setting to
force a row below into a different tier — each row's "Expected tier" is what the live
capability probe should converge on for that host, unaided.

For every row, "browse / open / edit / save / terminal" means:

1. **Browse** — the file tree lists the workspace contents.
2. **Open** — opening a file shows its content in an editor surface.
3. **Edit** — a change made in the editor is reflected back to the model via `editor_state`
   (or, in `embedded`/`browser`, is visible to a human watching the workbench).
4. **Save** — the change persists to disk; a concurrent on-disk change surfaces as a
   non-destructive `VERSION_CONFLICT`, never a silent overwrite.
5. **Terminal** — a shell command can be started and its output observed.

## Host rows

| Host | Expected tier | Verification notes |
| --- | --- | --- |
| Claude Desktop (local stdio connector) | `native` | **The motivating case.** Claude Desktop forwards `connectDomains`/`resourceDomains` but drops `frameDomains` (see `docs/upstream-frame-domains-report.md`), so `embedded` is never reachable here — `native` must carry the full experience. Verify browse / open / edit / save / terminal all work entirely inside the MCP App view, with no iframe and no external browser tab. Confirm the statusbar reports `native` and its tooltip explains why (assets + `/ui` both reachable). |
| FLUJO | `native`; then force an asset failure to verify `embedded` | FLUJO is spec-compliant and allows framing, so it should also land on `native` first (order is fixed, native always wins when reachable). To exercise Tier 2 on this host, temporarily make `/assets/manifest.json` unreachable (e.g. block the route or point `assetsUrl` at a closed port) and confirm the app falls through to `embedded`, showing the real OpenVSCode workbench and receiving the `mcp-vscode:workbench-alive` liveness message (not just a `load` event). This proves `embedded` is still reachable end-to-end where framing is permitted. |
| `standalone/` release in a plain browser | `native` first; `embedded` also reachable | Plain browsers apply no MCP-specific CSP restrictions beyond what the server declares, so both `native` and `embedded` should succeed when probed independently. Verify `native` commits by default (assets + `/ui` reachable immediately), then repeat the asset-failure trick above to confirm `embedded` also renders correctly as the fallback. |
| macOS (no upstream `openvscode-server` build) | `native`, automatically | Install on macOS, where no OpenVSCode runtime package is available for this platform (`@mario.andreschak/mcp-vscode-*` ships no darwin runtime). `embedded`/`browser` have no `ideUrl` to point at, but `/assets` and `/ui` are served directly by the MCP VS Code process regardless of the OpenVSCode runtime, so `native` should still commit with no configuration change. This is the acceptance-criterion #12 "macOS side benefit": the platform stops being hard-blocked, without a flag. |

## What to record for each row

- The tier the statusbar actually reports (and its tooltip text).
- Whether browse / open / edit / save / terminal all succeeded.
- Whether a forced-degradation edge (asset failure, socket failure, framing failure) was
  exercised where applicable, and what tier it converged on.
- Any unhandled promise rejection, blank render, or leaked iframe/socket/timer observed in
  the browser/devtools console during the run.

This manual pass complements, but does not replace, the automated tier-permutation
integration tests, which simulate the same capability failures deterministically without a
real host.
