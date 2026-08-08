// Trailing-edge, cancellable debouncer. Pure/dependency-free (only uses
// `setTimeout`/`clearTimeout`, available under both the DOM and `node
// --test`), extracted so it is unit-testable without a DOM -- none of this
// existed in the repo before Phase 3 (plan §4.1).
//
// Used by `src/app/model-context.ts` (debounced `updateModelContext` push)
// and `src/app/terminal.ts` (debounced resize RPC) in a later wave.

export interface Debouncer<Args extends unknown[]> {
  /** Schedule `fn` to run after `ms` of quiet, with the latest `args`.
   * Any pending, not-yet-fired call is replaced (trailing-edge only --
   * `fn` never runs on the leading edge). */
  (...args: Args): void;
  /** Discard any pending call without running `fn`. */
  cancel(): void;
  /** If a call is pending, run `fn` immediately (with its latest args) and
   * clear the timer; otherwise a no-op. */
  flush(): void;
  /** Whether a call is currently pending (timer armed). */
  readonly pending: boolean;
}

/**
 * Creates a trailing-edge debounced wrapper around `fn`. Calling the
 * returned function resets the `ms` timer each time; `fn` only runs once
 * the timer elapses without another call, and always with the arguments of
 * the *last* call in that window (so rapid, identical or differing calls
 * naturally collapse/dedupe into a single invocation).
 */
export function createDebouncer<Args extends unknown[]>(
  ms: number,
  fn: (...args: Args) => void,
): Debouncer<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: Args | undefined;

  function run(): void {
    timer = undefined;
    const argsToRun = pendingArgs;
    pendingArgs = undefined;
    if (argsToRun) fn(...argsToRun);
  }

  const debounced = ((...args: Args) => {
    pendingArgs = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as Debouncer<Args>;

  Object.defineProperty(debounced, "pending", {
    get: () => timer !== undefined,
  });

  debounced.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pendingArgs = undefined;
  };

  debounced.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    run();
  };

  return debounced;
}
