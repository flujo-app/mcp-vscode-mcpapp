import assert from "node:assert/strict";
import test from "node:test";
import {
  INVALID_EDIT_RANGE,
  normalizeEditOperations,
  toMonacoEditOperation,
  toMonacoEditOperations,
  toMonacoRange,
} from "../src/app/edit-ops.js";
import { McpVscodeError } from "../src/core/errors.js";

// Pure range/edit-operation mapping + validation (plan §3.2/§3.3): no DOM,
// no `monaco-editor` runtime import, so exercised directly under
// `node --test`.

test("toMonacoRange is a straight rename of the 1-based MCP fields", () => {
  const range = toMonacoRange({ startLine: 3, startColumn: 1, endLine: 5, endColumn: 10 });
  assert.deepEqual(range, {
    startLineNumber: 3,
    startColumn: 1,
    endLineNumber: 5,
    endColumn: 10,
  });
});

test("toMonacoEditOperation maps range + text", () => {
  const op = toMonacoEditOperation({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, text: "hi" });
  assert.deepEqual(op, {
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    text: "hi",
  });
});

test("normalizeEditOperations sorts non-overlapping edits in descending start order", () => {
  const edits = [
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, text: "a" },
    { startLine: 10, startColumn: 1, endLine: 10, endColumn: 5, text: "b" },
    { startLine: 5, startColumn: 3, endLine: 5, endColumn: 3, text: "c" },
  ];
  const sorted = normalizeEditOperations(edits);
  assert.deepEqual(
    sorted.map((e) => e.text),
    ["b", "c", "a"],
  );
});

test("normalizeEditOperations sorts by column when lines are equal", () => {
  const edits = [
    { startLine: 2, startColumn: 5, endLine: 2, endColumn: 5, text: "later" },
    { startLine: 2, startColumn: 1, endLine: 2, endColumn: 1, text: "earlier" },
  ];
  const sorted = normalizeEditOperations(edits);
  assert.deepEqual(
    sorted.map((e) => e.text),
    ["later", "earlier"],
  );
});

test("normalizeEditOperations rejects an edit whose start is after its end", () => {
  assert.throws(
    () => normalizeEditOperations([{ startLine: 5, startColumn: 1, endLine: 3, endColumn: 1, text: "x" }]),
    (error: unknown) => {
      assert.ok(error instanceof McpVscodeError);
      assert.equal(error.code, INVALID_EDIT_RANGE);
      return true;
    },
  );
});

test("normalizeEditOperations rejects overlapping ranges", () => {
  const edits = [
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10, text: "a" },
    { startLine: 1, startColumn: 5, endLine: 1, endColumn: 8, text: "b" },
  ];
  assert.throws(
    () => normalizeEditOperations(edits),
    (error: unknown) => {
      assert.ok(error instanceof McpVscodeError);
      assert.equal(error.code, INVALID_EDIT_RANGE);
      return true;
    },
  );
});

test("normalizeEditOperations rejects overlapping ranges spanning multiple lines", () => {
  const edits = [
    { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1, text: "a" },
    { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5, text: "b" },
  ];
  assert.throws(() => normalizeEditOperations(edits));
});

test("normalizeEditOperations accepts ranges that merely touch (end === start)", () => {
  const edits = [
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5, text: "a" },
    { startLine: 1, startColumn: 5, endLine: 1, endColumn: 10, text: "b" },
  ];
  const sorted = normalizeEditOperations(edits);
  assert.equal(sorted.length, 2);
});

test("normalizeEditOperations accepts zero-width (cursor) edits at distinct positions", () => {
  const edits = [
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, text: "a" },
    { startLine: 1, startColumn: 2, endLine: 1, endColumn: 2, text: "b" },
  ];
  const sorted = normalizeEditOperations(edits);
  assert.equal(sorted.length, 2);
});

test("normalizeEditOperations passes through an empty batch", () => {
  assert.deepEqual(normalizeEditOperations([]), []);
});

test("toMonacoEditOperations validates, normalises and maps a whole batch", () => {
  const edits = [
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, text: "a" },
    { startLine: 3, startColumn: 1, endLine: 3, endColumn: 1, text: "b" },
  ];
  const ops = toMonacoEditOperations(edits);
  assert.deepEqual(
    ops.map((op) => op.text),
    ["b", "a"],
  );
  assert.deepEqual(ops[0]?.range, { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 });
});

test("toMonacoEditOperations rejects overlaps before mapping to Monaco operations", () => {
  const edits = [
    { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10, text: "a" },
    { startLine: 1, startColumn: 2, endLine: 1, endColumn: 3, text: "b" },
  ];
  assert.throws(
    () => toMonacoEditOperations(edits),
    (error: unknown) => {
      assert.ok(error instanceof McpVscodeError);
      assert.equal(error.code, INVALID_EDIT_RANGE);
      return true;
    },
  );
});
