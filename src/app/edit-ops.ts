// Pure, dependency-free helpers for turning MCP `editor_apply_edits` tool
// input into Monaco edit operations. No DOM, no `monaco-editor` *runtime*
// import (only `import type`) so this module is fully exercisable under
// `node --test` -- see tests/editor-edits.test.ts.
//
// MCP tool input is 1-based `startLine/startColumn/endLine/endColumn`
// (`server.ts:216-228`); Monaco's `IRange` is also 1-based
// (`startLineNumber`, `startColumn`, ...), so the mapping is a rename, but it
// is isolated here so it can be unit-tested without a DOM (plan §3.3).
import type * as monaco from "monaco-editor/editor/editor.api.js";
import { McpVscodeError } from "../core/errors.js";

/** 1-based range, matching the shape of the MCP tool's edit input fields. */
export interface EditRangeInput {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** One replacement edit: the range to replace and the replacement text. */
export interface EditOperationInput extends EditRangeInput {
  readonly text: string;
}

/** Thrown by {@link normalizeEditOperations} when edits are malformed or
 * overlap. Carries the `INVALID_EDIT_RANGE` code the tool layer surfaces to
 * the MCP caller (plan §3.2: "Overlapping ranges must be REJECTED ... rather
 * than silently corrupting the buffer."). */
export const INVALID_EDIT_RANGE = "INVALID_EDIT_RANGE";

/** Rename-only mapping from the MCP tool's 1-based range fields to Monaco's
 * 1-based `IRange`. */
export function toMonacoRange(range: EditRangeInput): monaco.IRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  };
}

/** Maps one MCP edit into a Monaco `IIdentifiedSingleEditOperation`, ready
 * to hand to `model.pushEditOperations()` / `editor.executeEdits()`. Does
 * NOT validate or reorder -- call {@link normalizeEditOperations} (or
 * {@link toMonacoEditOperations}) first for a batch. */
export function toMonacoEditOperation(edit: EditOperationInput): monaco.editor.IIdentifiedSingleEditOperation {
  return {
    range: toMonacoRange(edit),
    text: edit.text,
  };
}

type Position = readonly [line: number, column: number];

function startOf(range: EditRangeInput): Position {
  return [range.startLine, range.startColumn];
}

function endOf(range: EditRangeInput): Position {
  return [range.endLine, range.endColumn];
}

function comparePositions(a: Position, b: Position): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

function rangesOverlap(a: EditRangeInput, b: EditRangeInput): boolean {
  // Half-open interval overlap test on (line, column) tuples: a and b
  // overlap iff a starts before b ends AND b starts before a ends.
  // Zero-width ranges that merely touch (a.end === b.start) do not overlap.
  return comparePositions(startOf(a), endOf(b)) < 0 && comparePositions(startOf(b), endOf(a)) < 0;
}

/**
 * Validates a batch of edits and returns them sorted in descending order of
 * start position (plan §3.2: "Edits are applied descending by start
 * position ... so earlier offsets are not invalidated.").
 *
 * Throws {@link McpVscodeError} with code `INVALID_EDIT_RANGE` when:
 * - any edit's start position is after its own end position, or
 * - any two edits' ranges overlap.
 */
export function normalizeEditOperations<T extends EditRangeInput>(edits: readonly T[]): T[] {
  for (const edit of edits) {
    if (comparePositions(startOf(edit), endOf(edit)) > 0) {
      throw new McpVscodeError(
        `Edit range start must not be after its end (got ${JSON.stringify(edit)})`,
        INVALID_EDIT_RANGE,
        { edit },
      );
    }
  }

  for (let i = 0; i < edits.length; i++) {
    const a = edits[i];
    if (!a) continue;
    for (let j = i + 1; j < edits.length; j++) {
      const b = edits[j];
      if (!b) continue;
      if (rangesOverlap(a, b)) {
        throw new McpVscodeError("Overlapping edit ranges are not allowed", INVALID_EDIT_RANGE, {
          a,
          b,
        });
      }
    }
  }

  return [...edits].sort((a, b) => comparePositions(startOf(b), startOf(a)));
}

/** Validates, normalises (descending-order) and maps a whole batch of MCP
 * edits into Monaco edit operations in one call -- the shape
 * `src/app/editor.ts#applyEdits` is expected to consume. */
export function toMonacoEditOperations(
  edits: readonly EditOperationInput[],
): monaco.editor.IIdentifiedSingleEditOperation[] {
  return normalizeEditOperations(edits).map(toMonacoEditOperation);
}
