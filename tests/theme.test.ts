import assert from "node:assert/strict";
import test from "node:test";
import { buildMonacoTheme, buildXtermTheme, normalizeColor } from "../src/app/theme.js";

// Pure host-token -> Monaco/xterm colour mapping (plan §4.2): light mode,
// dark mode, missing tokens, and unparseable colour values. No DOM, no
// `monaco-editor`/`@xterm/xterm` runtime import.

const LIGHT_TOKENS = {
  "--color-background-primary": "#ffffff",
  "--color-background-secondary": "#f0f0f0",
  "--color-background-tertiary": "#e0e0e0",
  "--color-text-primary": "#111111",
  "--color-text-tertiary": "#777777",
  "--color-ring-primary": "#0066ff",
};

const DARK_TOKENS = {
  "--color-background-primary": "#101010",
  "--color-background-secondary": "#181818",
  "--color-background-tertiary": "#202020",
  "--color-text-primary": "#eeeeee",
  "--color-text-tertiary": "#999999",
  "--color-ring-primary": "#66aaff",
};

test("buildMonacoTheme: light mode maps every token and uses the vs base", () => {
  const theme = buildMonacoTheme(LIGHT_TOKENS, "light");
  assert.equal(theme.base, "vs");
  assert.equal(theme.inherit, true);
  assert.deepEqual(theme.colors, {
    "editor.background": "#ffffff",
    "editor.foreground": "#111111",
    "editorLineNumber.foreground": "#777777",
    "editorWidget.background": "#f0f0f0",
    "editorGutter.background": "#ffffff",
    "editor.selectionBackground": "#e0e0e0",
    focusBorder: "#0066ff",
  });
});

test("buildMonacoTheme: dark mode maps every token and uses the vs-dark base", () => {
  const theme = buildMonacoTheme(DARK_TOKENS, "dark");
  assert.equal(theme.base, "vs-dark");
  assert.equal(theme.inherit, true);
  assert.deepEqual(theme.colors, {
    "editor.background": "#101010",
    "editor.foreground": "#eeeeee",
    "editorLineNumber.foreground": "#999999",
    "editorWidget.background": "#181818",
    "editorGutter.background": "#101010",
    "editor.selectionBackground": "#202020",
    focusBorder: "#66aaff",
  });
});

test("buildMonacoTheme: missing tokens fall back to the built-in default for the mode", () => {
  const theme = buildMonacoTheme({}, "dark");
  assert.equal(theme.colors["editor.background"], "#1e1e1e");
  assert.equal(theme.colors["editor.foreground"], "#d4d4d4");
  assert.equal(theme.colors["focusBorder"], "#007fd4");

  const lightTheme = buildMonacoTheme({}, "light");
  assert.equal(lightTheme.colors["editor.background"], "#ffffff");
  assert.equal(lightTheme.colors["focusBorder"], "#0090f1");
});

test("buildMonacoTheme: unparseable colour values fall back silently instead of throwing", () => {
  const tokens = {
    "--color-background-primary": "oklch(0.2 0.02 250)",
    "--color-text-primary": "color-mix(in srgb, red 50%, blue)",
    "--color-background-secondary": "papayawhip",
  };
  assert.doesNotThrow(() => buildMonacoTheme(tokens, "dark"));
  const theme = buildMonacoTheme(tokens, "dark");
  assert.equal(theme.colors["editor.background"], "#1e1e1e");
  assert.equal(theme.colors["editor.foreground"], "#d4d4d4");
  assert.equal(theme.colors["editorWidget.background"], "#252526");
});

test("buildXtermTheme: light and dark modes map background/foreground/cursor/selection", () => {
  const light = buildXtermTheme(LIGHT_TOKENS, "light");
  assert.deepEqual(light, {
    background: "#ffffff",
    foreground: "#111111",
    cursor: "#111111",
    selectionBackground: "#e0e0e0",
  });

  const dark = buildXtermTheme(DARK_TOKENS, "dark");
  assert.deepEqual(dark, {
    background: "#101010",
    foreground: "#eeeeee",
    cursor: "#eeeeee",
    selectionBackground: "#202020",
  });
});

test("buildXtermTheme: missing/unparseable tokens fall back to defaults without throwing", () => {
  assert.doesNotThrow(() => buildXtermTheme({ "--color-background-primary": "oklch(1 0 0)" }, "dark"));
  const theme = buildXtermTheme({}, "light");
  assert.equal(theme.background, "#ffffff");
  assert.equal(theme.foreground, "#000000");
});

test("normalizeColor: parses #rgb/#rrggbb/#rrggbbaa hex forms", () => {
  assert.equal(normalizeColor("#abc", "#000000"), "#aabbcc");
  assert.equal(normalizeColor("#abcd", "#000000"), "#aabbccdd");
  assert.equal(normalizeColor("#123456", "#000000"), "#123456");
  assert.equal(normalizeColor("#12345678", "#000000"), "#12345678");
  assert.equal(normalizeColor("#ABCDEF", "#000000"), "#abcdef");
});

test("normalizeColor: parses rgb()/rgba() forms", () => {
  assert.equal(normalizeColor("rgb(255, 0, 128)", "#000000"), "#ff0080");
  assert.equal(normalizeColor("rgba(255, 0, 128, 0.5)", "#000000"), "#ff008080");
});

test("normalizeColor: falls back for missing tokens", () => {
  assert.equal(normalizeColor(undefined, "#123123"), "#123123");
  assert.equal(normalizeColor("", "#123123"), "#123123");
  assert.equal(normalizeColor("   ", "#123123"), "#123123");
});

test("normalizeColor: falls back for unparseable values and never throws", () => {
  assert.equal(normalizeColor("oklch(0.7 0.1 200)", "#123123"), "#123123");
  assert.equal(normalizeColor("color-mix(in srgb, red 50%, blue)", "#123123"), "#123123");
  assert.equal(normalizeColor("papayawhip", "#123123"), "#123123");
  assert.equal(normalizeColor("not-a-color", "#123123"), "#123123");
});

test("normalizeColor: uses the injectable resolve() for values it cannot parse itself", () => {
  const resolved = normalizeColor("papayawhip", "#000000", {
    resolve: (value) => (value === "papayawhip" ? "rgb(255, 239, 213)" : undefined),
  });
  assert.equal(resolved, "#ffefd5");
});

test("normalizeColor: falls back when resolve() returns undefined or an unparseable value", () => {
  assert.equal(
    normalizeColor("mystery", "#123123", { resolve: () => undefined }),
    "#123123",
  );
  assert.equal(
    normalizeColor("mystery", "#123123", { resolve: () => "still-not-a-color" }),
    "#123123",
  );
});

test("normalizeColor: never throws even if resolve() itself throws", () => {
  assert.doesNotThrow(() =>
    normalizeColor("mystery", "#123123", {
      resolve: () => {
        throw new Error("no CSSStyleValue in Node");
      },
    }),
  );
  assert.equal(
    normalizeColor("mystery", "#123123", {
      resolve: () => {
        throw new Error("no CSSStyleValue in Node");
      },
    }),
    "#123123",
  );
});
