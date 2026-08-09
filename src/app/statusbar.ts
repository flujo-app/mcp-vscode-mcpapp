// Small render helper for the titlebar/statusbar tier badge and connection
// state; kept out of `main.ts` purely to keep that file's orchestration logic
// readable.
import type { Tier } from "./tier.js";

const TIER_LABEL: Record<Tier, string> = {
  probing: "Detecting…",
  stream: "Streamed (experimental)",
  embedded: "Embedded",
  browser: "Browser",
};

export class StatusBar {
  readonly #tierBadge: HTMLElement;
  readonly #connectionBadge: HTMLElement;
  readonly #root: HTMLElement;

  constructor(root: HTMLElement, tierBadge: HTMLElement, connectionBadge: HTMLElement) {
    this.#root = root;
    this.#tierBadge = tierBadge;
    this.#connectionBadge = connectionBadge;
  }

  setTier(tier: Tier, reason?: string): void {
    this.#tierBadge.textContent = TIER_LABEL[tier];
    this.#tierBadge.className = `status-item tier-badge tier-badge--${tier}`;
    // Surface the renderer decision rather than hiding policy/network failures.
    this.#tierBadge.title = reason ? `${TIER_LABEL[tier]} — ${reason}` : TIER_LABEL[tier];
  }

  setConnection(state: "connecting" | "open" | "closed" | "waiting"): void {
    this.#connectionBadge.textContent = state === "open" ? "connected" : state === "closed" ? "disconnected" : "waiting";
  }

  setError(active: boolean): void {
    this.#root.classList.toggle("error", active);
  }
}
