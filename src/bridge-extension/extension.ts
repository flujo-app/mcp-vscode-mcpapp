import * as vscode from "vscode";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

interface WireMessage {
  type: string;
  id?: string;
  method?: string;
  params?: unknown;
  event?: string;
  data?: unknown;
}

let connection: BridgeConnection | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const url = process.env.MCP_VSCODE_BRIDGE_URL;
  const token = process.env.MCP_VSCODE_BRIDGE_TOKEN;
  if (!url || !token) {
    void vscode.window.showWarningMessage("MCP VS Code bridge environment is not configured.");
    return;
  }
  connection = new BridgeConnection(url, token, context);
  context.subscriptions.push(connection);
  connection.start();
}

export function deactivate(): void {
  connection?.dispose();
}

class BridgeConnection implements vscode.Disposable {
  readonly #url: string;
  readonly #token: string;
  readonly #context: vscode.ExtensionContext;
  readonly #documentTimers = new Map<string, NodeJS.Timeout>();
  readonly #sharedTerminals = new Map<string, SharedPseudoterminal>();
  readonly #pendingPtys = new Map<string, SharedPseudoterminal>();
  #socket?: WebSocket;
  #disposed = false;
  #retryMs = 250;
  #connected = false;

  constructor(url: string, token: string, context: vscode.ExtensionContext) {
    this.#url = url;
    this.#token = token;
    this.#context = context;
    context.subscriptions.push(
      vscode.commands.registerCommand("mcp-vscode.createSharedTerminal", () => this.#createSharedTerminal()),
      vscode.commands.registerCommand("mcp-vscode.showConnectionStatus", () => {
        void vscode.window.showInformationMessage(
          this.#connected ? "MCP VS Code bridge is connected." : "MCP VS Code bridge is disconnected.",
        );
      }),
      vscode.window.registerTerminalProfileProvider("mcp-vscode.shared", {
        provideTerminalProfile: () => new vscode.TerminalProfile({
          name: "MCP Shared Terminal",
          pty: this.#newSharedPty("MCP Shared Terminal"),
        }),
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.#scheduleDocumentEvent(event.document)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const relativePath = workspaceRelativePath(document.uri);
        if (relativePath) this.#sendEvent("document.saved", { path: relativePath });
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const relativePath = workspaceRelativePath(document.uri);
        if (relativePath) this.#sendEvent("document.closed", { path: relativePath });
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.#sendEditorState()),
      vscode.window.onDidChangeTextEditorSelection(() => this.#sendEditorState()),
      vscode.languages.onDidChangeDiagnostics(() => this.#sendEvent("diagnostics.changed", {})),
    );
  }

  start(): void {
    if (this.#disposed) return;
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "hello",
        token: this.#token,
        client: {
          name: "mcp-vscode-bridge",
          version: this.#context.extension.packageJSON.version,
          vscodeVersion: vscode.version,
        },
      }));
    });
    socket.on("message", (raw) => {
      let message: WireMessage;
      try {
        message = JSON.parse(raw.toString()) as WireMessage;
      } catch {
        return;
      }
      if (message.type === "hello-result") {
        this.#connected = true;
        this.#retryMs = 250;
        this.#sendEditorState();
      } else if (message.type === "rpc" && message.id && message.method) {
        void this.#handleRpc(message.id, message.method, message.params);
      } else if (message.type === "event" && message.event) {
        this.#handleServerEvent(message.event, message.data as Record<string, unknown> | undefined);
      }
    });
    socket.on("close", () => this.#reconnect());
    socket.on("error", () => {
      this.#connected = false;
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#socket?.close();
    for (const timer of this.#documentTimers.values()) clearTimeout(timer);
    this.#documentTimers.clear();
  }

  #reconnect(): void {
    this.#connected = false;
    if (this.#disposed) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, 10_000);
    setTimeout(() => this.start(), delay).unref();
  }

  async #handleRpc(id: string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#dispatch(method, asRecord(params));
      this.#send({ type: "rpc-result", id, result: jsonSafe(result) });
    } catch (error) {
      this.#send({
        type: "rpc-result",
        id,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  }

  async #dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "editor.open":
        return await this.#openEditor(params);
      case "editor.state":
        return editorState();
      case "editor.setSelection":
        return await this.#setSelection(params);
      case "editor.applyEdits":
        return await this.#applyEdits(params);
      case "workspace.writeFile":
        return await this.#writeFile(params);
      case "diagnostics.get":
        return diagnostics(params.path);
      case "commands.list":
        return { commands: await vscode.commands.getCommands(params.includeInternal === true) };
      case "commands.execute":
        return await vscode.commands.executeCommand(
          requiredString(params.command, "command"),
          ...asArray(params.arguments),
        );
      case "extensions.list":
        return {
          extensions: vscode.extensions.all.map((extension) => ({
            id: extension.id,
            path: extension.extensionPath,
            active: extension.isActive,
            packageJSON: {
              name: extension.packageJSON.name,
              displayName: extension.packageJSON.displayName,
              version: extension.packageJSON.version,
              publisher: extension.packageJSON.publisher,
            },
          })),
        };
      case "extensions.install": {
        const extension = requiredString(params.extension, "extension");
        const target = extension.includes("://") ? vscode.Uri.parse(extension) : extension;
        return await vscode.commands.executeCommand("workbench.extensions.installExtension", target);
      }
      case "extensions.uninstall":
        return await vscode.commands.executeCommand(
          "workbench.extensions.uninstallExtension",
          requiredString(params.extension, "extension"),
        );
      default:
        throw new Error(`Unsupported bridge RPC method: ${method}`);
    }
  }

  async #openEditor(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const document = await vscode.workspace.openTextDocument(workspaceUri(requiredString(params.path, "path")));
    const editor = await vscode.window.showTextDocument(document, {
      preview: params.preview === true,
      preserveFocus: params.preserveFocus === true,
    });
    if (typeof params.line === "number") {
      const position = new vscode.Position(
        Math.max(0, params.line - 1),
        Math.max(0, (typeof params.column === "number" ? params.column : 1) - 1),
      );
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    return { path: workspaceRelativePath(document.uri), languageId: document.languageId };
  }

  async #setSelection(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const document = await vscode.workspace.openTextDocument(workspaceUri(requiredString(params.path, "path")));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const selection = rangeFromParams(params);
    editor.selection = new vscode.Selection(selection.start, selection.end);
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return { selected: true, path: workspaceRelativePath(document.uri) };
  }

  async #applyEdits(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const uri = workspaceUri(requiredString(params.path, "path"));
    const document = await vscode.workspace.openTextDocument(uri);
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const raw of asArray(params.edits)) {
      const edit = asRecord(raw);
      workspaceEdit.replace(uri, rangeFromParams(edit), requiredString(edit.text, "text"));
    }
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    const saved = params.save === false ? false : await document.save();
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    return { applied, saved, path: workspaceRelativePath(uri), version: document.version };
  }

  async #writeFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const uri = workspaceUri(requiredString(params.path, "path"));
    const content = requiredString(params.content, "content");
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      document = await vscode.workspace.openTextDocument(uri);
    }
    const lastLine = document.lineAt(Math.max(0, document.lineCount - 1));
    const fullRange = new vscode.Range(new vscode.Position(0, 0), lastLine.rangeIncludingLineBreak.end);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, content);
    const applied = await vscode.workspace.applyEdit(edit);
    const saved = await document.save();
    return { applied, saved, path: workspaceRelativePath(uri), documentVersion: document.version };
  }

  #scheduleDocumentEvent(document: vscode.TextDocument): void {
    const relativePath = workspaceRelativePath(document.uri);
    if (!relativePath || document.getText().length > 2_000_000) return;
    const key = document.uri.toString();
    const existing = this.#documentTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#documentTimers.delete(key);
      this.#sendEvent("document.changed", {
        path: relativePath,
        content: document.getText(),
        dirty: document.isDirty,
        documentVersion: document.version,
      });
    }, 40);
    this.#documentTimers.set(key, timer);
  }

  #sendEditorState(): void {
    this.#sendEvent("editor.stateChanged", editorState());
  }

  #sendEvent(event: string, data: unknown): void {
    this.#send({ type: "event", event, data });
  }

  #send(message: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #createSharedTerminal(): vscode.Terminal {
    const pty = this.#newSharedPty("MCP Shared Terminal");
    const terminal = vscode.window.createTerminal({ name: "MCP Shared Terminal", pty });
    terminal.show();
    return terminal;
  }

  #newSharedPty(name: string): SharedPseudoterminal {
    const requestId = randomUUID();
    const pty = new SharedPseudoterminal(
      requestId,
      (event, data) => this.#sendEvent(event, data),
      () => this.#pendingPtys.delete(requestId),
    );
    this.#pendingPtys.set(requestId, pty);
    return pty;
  }

  #handleServerEvent(event: string, data: Record<string, unknown> | undefined): void {
    if (!data) return;
    if (event === "terminal.created" && typeof data.id === "string") {
      const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
      let pty = requestId ? this.#pendingPtys.get(requestId) : undefined;
      if (pty && requestId) this.#pendingPtys.delete(requestId);
      if (!pty) {
        pty = new SharedPseudoterminal(undefined, (name, value) => this.#sendEvent(name, value));
        const terminal = vscode.window.createTerminal({
          name: typeof data.name === "string" ? data.name : "MCP Terminal",
          pty,
        });
        terminal.show(true);
      }
      pty.attach(data.id);
      this.#sharedTerminals.set(data.id, pty);
    } else if (event === "terminal.output" && typeof data.id === "string" && typeof data.data === "string") {
      this.#sharedTerminals.get(data.id)?.write(data.data);
    } else if (event === "terminal.exited" && typeof data.id === "string") {
      this.#sharedTerminals.get(data.id)?.exit(typeof data.exitCode === "number" ? data.exitCode : undefined);
      this.#sharedTerminals.delete(data.id);
    }
  }
}

class SharedPseudoterminal implements vscode.Pseudoterminal {
  readonly #writeEmitter = new vscode.EventEmitter<string>();
  readonly #closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.#writeEmitter.event;
  readonly onDidClose = this.#closeEmitter.event;
  readonly #requestId?: string;
  readonly #send: (event: string, data: unknown) => void;
  readonly #onClose?: () => void;
  #id?: string;

  constructor(
    requestId: string | undefined,
    send: (event: string, data: unknown) => void,
    onClose?: () => void,
  ) {
    this.#requestId = requestId;
    this.#send = send;
    this.#onClose = onClose;
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (!this.#requestId) return;
    this.#send("terminal.createRequested", {
      requestId: this.#requestId,
      name: "MCP Shared Terminal",
      columns: initialDimensions?.columns,
      rows: initialDimensions?.rows,
    });
  }

  close(): void {
    if (this.#id) this.#send("terminal.close", { id: this.#id });
    this.#onClose?.();
  }

  handleInput(data: string): void {
    if (this.#id) this.#send("terminal.input", { id: this.#id, data });
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.#id) this.#send("terminal.resize", { id: this.#id, ...dimensions });
  }

  attach(id: string): void {
    this.#id = id;
  }

  write(data: string): void {
    this.#writeEmitter.fire(data);
  }

  exit(code?: number): void {
    this.#closeEmitter.fire(code);
  }
}

function workspaceUri(relativePath: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder is open");
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) throw new Error("Path escapes the workspace");
  return vscode.Uri.joinPath(folder.uri, ...parts);
}

function workspaceRelativePath(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder || uri.scheme !== folder.uri.scheme || uri.authority !== folder.uri.authority) return undefined;
  const base = folder.uri.path.endsWith("/") ? folder.uri.path : `${folder.uri.path}/`;
  return uri.path === folder.uri.path ? "." : uri.path.startsWith(base) ? uri.path.slice(base.length) : undefined;
}

function editorState(): Record<string, unknown> {
  const active = vscode.window.activeTextEditor;
  return {
    active: active ? editorDescriptor(active) : undefined,
    visible: vscode.window.visibleTextEditors.map(editorDescriptor),
    workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => ({
      name: folder.name,
      index: folder.index,
      uri: folder.uri.toString(),
    })) ?? [],
    dirtyDocuments: vscode.workspace.textDocuments
      .filter((document) => document.isDirty)
      .map((document) => ({ path: workspaceRelativePath(document.uri), version: document.version })),
  };
}

function editorDescriptor(editor: vscode.TextEditor): Record<string, unknown> {
  return {
    path: workspaceRelativePath(editor.document.uri),
    uri: editor.document.uri.toString(),
    languageId: editor.document.languageId,
    version: editor.document.version,
    dirty: editor.document.isDirty,
    selections: editor.selections.map((selection) => ({
      startLine: selection.start.line + 1,
      startColumn: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
    })),
  };
}

function diagnostics(pathValue: unknown): Record<string, unknown> {
  const selected = typeof pathValue === "string"
    ? vscode.languages.getDiagnostics(workspaceUri(pathValue))
    : vscode.languages.getDiagnostics();
  if (Array.isArray(selected) && selected.length > 0 && Array.isArray(selected[0])) {
    return {
      diagnostics: (selected as Array<[vscode.Uri, vscode.Diagnostic[]]>).map(([uri, values]) => ({
        path: workspaceRelativePath(uri),
        values: values.map(diagnosticDescriptor),
      })),
    };
  }
  return { diagnostics: (selected as vscode.Diagnostic[]).map(diagnosticDescriptor) };
}

function diagnosticDescriptor(diagnostic: vscode.Diagnostic): Record<string, unknown> {
  return {
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: diagnostic.source,
    code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
    range: {
      startLine: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLine: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
    },
  };
}

function rangeFromParams(params: Record<string, unknown>): vscode.Range {
  return new vscode.Range(
    requiredNumber(params.startLine, "startLine") - 1,
    requiredNumber(params.startColumn, "startColumn") - 1,
    requiredNumber(params.endLine, "endLine") - 1,
    requiredNumber(params.endColumn, "endColumn") - 1,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}
