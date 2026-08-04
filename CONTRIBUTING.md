# Contributing

Contributions are welcome through issues and pull requests.

Before submitting a change:

```bash
npm ci
npm run check
```

Keep new filesystem operations routed through the confined `Workspace` abstraction. Mark destructive or open-world MCP tools accurately, and add an integration test for changes to authentication, proxying, transports, or bridge RPC.

OpenVSCode itself is an upstream project. General editor behavior fixes should normally be contributed to Code OSS or OpenVSCode Server; this repository owns packaging, MCP integration, synchronization, and sandbox embedding.

Native Windows runtime changes must keep the OpenVSCode source commit pinned, produce the `vscode-reh-web-win32-x64` artifact on a Windows runner, and pass `npm run test:runtime` against that real artifact. The standalone release must not require Visual Studio, Git, Node.js, WSL, or Docker on the end-user machine.
