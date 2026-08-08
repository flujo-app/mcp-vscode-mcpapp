// Pure host-theme -> Monaco/xterm colour mapping (plan §4.2). No DOM, no
// `monaco-editor`/`@xterm/xterm` *runtime* import (only `import type`), so
// this module is fully exercisable under `node --test`.
//
// `normalizeColor()` must NEVER throw (plan risk R5): host tokens may be
// `oklch()`, `color-mix()`, or named colours, which Monaco rejects. The
// DOM-dependent resolution path (a throwaway canvas/`CSSStyleValue`, only
// available in a browser) is injected via `NormalizeColorOptions.resolve`
// so the pure fallback logic stays fully unit-testable without a DOM; the
// thin applier in a later wave supplies a real `resolve` in the browser.
import type * as monaco from "monaco-editor/editor/editor.api.js";
import type { ITheme } from "@xterm/xterm";

export type ThemeMode = "light" | "dark";

/** Host CSS custom-property values, keyed by the exact `--color-*` variable
 * name (e.g. `"--color-background-primary"`). Missing/`undefined` entries
 * fall back to the built-in default for `mode`. */
export type HostTokenMap = Readonly<Record<string, string | undefined>>;

export interface NormalizeColorOptions {
  /** Optional DOM-dependent resolver for values `normalizeColor` cannot
   * parse itself (`oklch()`, `color-mix()`, named colours, ...). Not
   * available under `node --test`. Any exception it throws, or an
   * unresolvable/empty return, is treated as "could not resolve" and falls
   * through to `fallback` -- never propagated. */
  resolve?: (value: string) => string | undefined;
}

const HEX_RE = /^#([0-9a-fA-F]{3,8})$/;
const RGB_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHexByte(n: number): string {
  return clamp255(n).toString(16).padStart(2, "0");
}

function tryParseHex(value: string): string | undefined {
  const match = HEX_RE.exec(value);
  const hex = match?.[1];
  if (!hex) return undefined;
  if (![3, 4, 6, 8].includes(hex.length)) return undefined;
  if (hex.length === 3 || hex.length === 4) {
    const expanded = hex
      .split("")
      .map((c) => c + c)
      .join("");
    return `#${expanded.toLowerCase()}`;
  }
  return `#${hex.toLowerCase()}`;
}

function tryParseRgb(value: string): string | undefined {
  const match = RGB_RE.exec(value);
  if (!match) return undefined;
  const r = match[1];
  const g = match[2];
  const b = match[3];
  const a = match[4];
  if (!r || !g || !b) return undefined;
  const alphaHex = a !== undefined ? toHexByte(Number(a) * 255) : "";
  return `#${toHexByte(Number(r))}${toHexByte(Number(g))}${toHexByte(Number(b))}${alphaHex}`;
}

/**
 * Normalises a host colour token to `#rrggbb[aa]`, the only form Monaco
 * accepts in `IStandaloneThemeData.colors`. Recognises `#rgb[a]`/`#rrggbb[aa]`
 * and `rgb()`/`rgba()` directly (pure, no DOM needed); anything else
 * (`oklch()`, `color-mix()`, named colours, garbage) is handed to the
 * optional `options.resolve` callback, and if that does not produce a
 * parseable colour either, `fallback` is returned. Never throws.
 */
export function normalizeColor(value: string | undefined, fallback: string, options: NormalizeColorOptions = {}): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;

  const direct = tryParseHex(trimmed) ?? tryParseRgb(trimmed);
  if (direct) return direct;

  try {
    const resolved = options.resolve?.(trimmed);
    if (resolved) {
      const parsed = tryParseHex(resolved) ?? tryParseRgb(resolved);
      if (parsed) return parsed;
    }
  } catch {
    // Fall through to fallback -- normalizeColor must never throw.
  }

  return fallback;
}

/** Host token name -> Monaco theme colour id, per plan §4.2's mapping table. */
const MONACO_COLOR_TOKENS: ReadonlyArray<readonly [monacoColor: string, hostToken: string]> = [
  ["editor.background", "--color-background-primary"],
  ["editor.foreground", "--color-text-primary"],
  ["editorLineNumber.foreground", "--color-text-tertiary"],
  ["editorWidget.background", "--color-background-secondary"],
  ["editorGutter.background", "--color-background-primary"],
  ["editor.selectionBackground", "--color-background-tertiary"],
  ["focusBorder", "--color-ring-primary"],
];

const MONACO_DEFAULTS: Readonly<Record<ThemeMode, Readonly<Record<string, string>>>> = {
  dark: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "editorLineNumber.foreground": "#858585",
    "editorWidget.background": "#252526",
    "editorGutter.background": "#1e1e1e",
    "editor.selectionBackground": "#264f78",
    focusBorder: "#007fd4",
  },
  light: {
    "editor.background": "#ffffff",
    "editor.foreground": "#000000",
    "editorLineNumber.foreground": "#237893",
    "editorWidget.background": "#f3f3f3",
    "editorGutter.background": "#ffffff",
    "editor.selectionBackground": "#add6ff",
    focusBorder: "#0090f1",
  },
};

const XTERM_DEFAULTS: Readonly<Record<ThemeMode, Readonly<{ background: string; foreground: string; cursor: string; selectionBackground: string }>>> = {
  dark: { background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4", selectionBackground: "#264f78" },
  light: { background: "#ffffff", foreground: "#000000", cursor: "#000000", selectionBackground: "#add6ff" },
};

/**
 * Builds a Monaco `IStandaloneThemeData` from host CSS tokens (plan §4.2).
 * `base`/`inherit` are fixed so unmapped token colours keep sane defaults
 * while the chrome (background/foreground/gutter/selection/focus ring)
 * matches the host. Pure -- callers apply it via
 * `monaco.editor.defineTheme("mcp-host", buildMonacoTheme(...))`.
 */
export function buildMonacoTheme(
  tokens: HostTokenMap,
  mode: ThemeMode,
  options: NormalizeColorOptions = {},
): monaco.editor.IStandaloneThemeData {
  const defaults = MONACO_DEFAULTS[mode];
  const colors: Record<string, string> = {};
  for (const [monacoColor, hostToken] of MONACO_COLOR_TOKENS) {
    colors[monacoColor] = normalizeColor(tokens[hostToken], defaults[monacoColor] ?? "#000000", options);
  }
  return {
    base: mode === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors,
  };
}

/**
 * Builds an xterm `ITheme` from the same host CSS tokens (plan §4.2).
 * ANSI 16 colours are intentionally left unset so xterm's own defaults
 * apply -- the host token set carries no ANSI palette.
 */
export function buildXtermTheme(tokens: HostTokenMap, mode: ThemeMode, options: NormalizeColorOptions = {}): ITheme {
  const defaults = XTERM_DEFAULTS[mode];
  return {
    background: normalizeColor(tokens["--color-background-primary"], defaults.background, options),
    foreground: normalizeColor(tokens["--color-text-primary"], defaults.foreground, options),
    cursor: normalizeColor(tokens["--color-text-primary"], defaults.cursor, options),
    selectionBackground: normalizeColor(tokens["--color-background-tertiary"], defaults.selectionBackground, options),
  };
}
