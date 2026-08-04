import http from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { port: { type: "string", default: "3999" }, host: { type: "string", default: "127.0.0.1" } },
});
const port = Number.parseInt(values.port, 10);
const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{height:100%;margin:0;font:12px Segoe UI,sans-serif;background:#1e1e1e;color:#ccc;overflow:hidden}
  .ide{height:100%;display:grid;grid-template:35px 1fr 22px/48px 220px 1fr}.top{grid-column:1/4;background:#181818;border-bottom:1px solid #2b2b2b;display:flex;align-items:center;justify-content:center;color:#bbb}.activity{background:#181818;border-right:1px solid #2b2b2b;padding-top:12px;text-align:center;font-size:21px;line-height:46px}.side{background:#181818;border-right:1px solid #2b2b2b;padding:12px}.side b{font-size:11px;letter-spacing:.08em}.file{margin-top:16px;padding:5px 8px;background:#37373d;color:#fff}.editor{display:grid;grid-template-rows:35px 1fr 160px}.tab{padding:10px 14px;background:#1e1e1e;border-bottom:1px solid #2b2b2b;color:#fff}.code{padding:16px 22px;font:13px/1.65 Consolas,monospace;background:#1e1e1e}.n{display:inline-block;width:28px;color:#666;text-align:right;margin-right:14px}.blue{color:#569cd6}.green{color:#6a9955}.terminal{border-top:1px solid #2b2b2b;padding:10px 16px;background:#181818;font:12px/1.55 Consolas,monospace}.status{grid-column:1/4;background:#007acc;color:white;padding:4px 10px}
  </style></head><body><div class="ide"><div class="top">mcp-vscode-mcpapp — OpenVSCode Server</div><div class="activity">▱<br>⌕<br>⑂<br>▦</div><aside class="side"><b>EXPLORER</b><div class="file">▾ mcp-vscode-mcpapp<br>&nbsp;&nbsp;▾ src<br>&nbsp;&nbsp;&nbsp;&nbsp;◇ cli.ts<br>&nbsp;&nbsp;&nbsp;&nbsp;◇ app<br>&nbsp;&nbsp;▤ package.json</div></aside><main class="editor"><div class="tab">cli.ts&nbsp; ×</div><div class="code"><div><span class="n">1</span><span class="blue">import</span> { VscodeCore } <span class="blue">from</span> <span class="green">&quot;./core/core.js&quot;</span>;</div><div><span class="n">2</span><span class="blue">import</span> { Gateway } <span class="blue">from</span> <span class="green">&quot;./http/gateway.js&quot;</span>;</div><div><span class="n">3</span></div><div><span class="n">4</span><span class="blue">await</span> main();</div></div><div class="terminal">TERMINAL&nbsp;&nbsp; OUTPUT&nbsp;&nbsp; PROBLEMS<br><br>PS /workspace&gt; npm test<br><span class="green">Tests passed. MCP bridge connected.</span><br>PS /workspace&gt; <span style="background:#ccc;color:#ccc">_</span></div></main><div class="status">⑂ main*&nbsp;&nbsp;&nbsp; ↻ MCP bridge connected</div></div></body></html>`);
});
server.listen(port, values.host, () => process.stderr.write(`Mock IDE listening on http://${values.host}:${port}\n`));
