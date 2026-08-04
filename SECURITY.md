# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting feature for this repository. Include the affected version, deployment mode, reproduction steps, and impact.

## Deployment guidance

- Keep the default loopback bind for stdio and local desktop use.
- Use a trusted TLS certificate, a strong bearer token, and an explicit `--public-url` for remote deployment.
- Place only the intended repository beneath `--workspace`; do not point it at a home directory or filesystem root.
- Treat `vscode_execute_command`, `terminal_write`, `git_run`, extension installation, and destructive file tools as privileged operations.
- Run the server as an unprivileged operating-system user and apply additional container or host isolation when opening untrusted repositories.
- Do not disable MCP host approvals merely because the OpenVSCode iframe is sandboxed. The terminal and extension host execute on the server side, outside the browser sandbox.

## Supported versions

Security fixes are applied to the latest release line. Until 1.0, users should upgrade to the newest published version rather than expecting backports.
