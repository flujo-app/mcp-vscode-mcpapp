import { EventEmitter } from "node:events";

export interface CoreEvent {
  type: string;
  at: string;
  data: unknown;
}

export class CoreEvents {
  readonly #emitter = new EventEmitter();

  emit(type: string, data: unknown): void {
    this.#emitter.emit("event", {
      type,
      at: new Date().toISOString(),
      data,
    } satisfies CoreEvent);
  }

  on(listener: (event: CoreEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}
