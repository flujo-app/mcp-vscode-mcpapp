import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";

export function npmSpawn(
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>;

export function normalizeNpmViewPayload(payload: unknown): unknown;

export function quoteForCmd(value: unknown): string;
