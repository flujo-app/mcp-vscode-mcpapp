import { randomBytes } from "node:crypto";
import { CoreEvents } from "./events.js";
import { VscodeBridge } from "./bridge.js";
import { EditorSurfaceRouter } from "./editor-surface.js";
import { TerminalManager } from "./terminal.js";
import { Workspace } from "./workspace.js";

export class VscodeCore {
  readonly events = new CoreEvents();
  readonly workspace: Workspace;
  readonly terminals = new TerminalManager(this.events);
  readonly bridgeToken = randomBytes(32).toString("base64url");
  readonly bridge = new VscodeBridge(this.bridgeToken, this.events);
  readonly editorSurface = new EditorSurfaceRouter(this.bridge);

  constructor(workspaceRoot: string) {
    this.workspace = new Workspace(workspaceRoot, this.events);
    this.events.on((event) => {
      this.bridge.broadcastEvent(event.type, event.data);
      const data = event.data as Record<string, unknown>;
      try {
        if (event.type === "vscode.terminal.input" && typeof data.id === "string" && typeof data.data === "string") {
          this.terminals.write(data.id, data.data);
        } else if (
          event.type === "vscode.terminal.resize"
          && typeof data.id === "string"
          && typeof data.columns === "number"
          && typeof data.rows === "number"
        ) {
          this.terminals.resize(data.id, data.columns, data.rows);
        } else if (event.type === "vscode.terminal.close" && typeof data.id === "string") {
          this.terminals.kill(data.id);
        } else if (event.type === "vscode.terminal.createRequested" && typeof data.requestId === "string") {
          void this.terminals.create({
            cwd: this.workspace.root,
            requestId: data.requestId,
            ...(typeof data.columns === "number" ? { columns: data.columns } : {}),
            ...(typeof data.rows === "number" ? { rows: data.rows } : {}),
            ...(typeof data.name === "string" ? { name: data.name } : {}),
          }).catch((error) => this.events.emit("terminal.error", { message: String(error) }));
        } else if (
          event.type === "vscode.document.changed"
          && typeof data.path === "string"
          && typeof data.content === "string"
          && typeof data.documentVersion === "number"
        ) {
          void this.workspace.updateOverlay({
            path: data.path,
            content: data.content,
            dirty: data.dirty === true,
            documentVersion: data.documentVersion,
          }).catch((error) => this.events.emit("workspace.overlay-error", { message: String(error) }));
        } else if (
          (event.type === "vscode.document.saved" || event.type === "vscode.document.closed")
          && typeof data.path === "string"
        ) {
          this.workspace.clearOverlay(data.path);
        }
      } catch (error) {
        this.events.emit("bridge.event-error", { source: event.type, message: String(error) });
      }
    });
  }

  async initialize(): Promise<void> {
    await this.workspace.initialize();
    await this.workspace.startWatching();
  }

  async close(): Promise<void> {
    this.terminals.closeAll();
    this.bridge.close();
    await this.workspace.close();
  }

  status(): Record<string, unknown> {
    return {
      workspaceRoot: this.workspace.root,
      bridge: this.bridge.status(),
      terminals: this.terminals.list(),
      overlays: this.workspace.overlays(),
      editorSurface: this.editorSurface.status(),
    };
  }
}
