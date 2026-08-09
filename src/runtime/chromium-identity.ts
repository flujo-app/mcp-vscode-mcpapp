const MAX_POSIX_ID = 0xffff_fffe;

export const STREAM_BROWSER_ACCOUNT = "node";

export interface ChromiumIdentitySelectionOptions {
  platform: NodeJS.Platform;
  effectiveUid: number | undefined;
  noSandbox: boolean;
  /** Contents of /etc/passwd. Required only for sandboxed POSIX root. */
  passwd?: string;
}

export type ChromiumIdentityDecision =
  | { kind: "inherit" }
  | { kind: "drop"; username: typeof STREAM_BROWSER_ACCOUNT; uid: number; gid: number }
  | { kind: "unavailable"; reason: string };

/**
 * Select the identity for the Chromium child without performing I/O.
 *
 * mcp-vscode may need to remain root in a managed container, but sandboxed
 * Chromium must not inherit that identity. The image's fixed `node` account
 * is the only automatically trusted drop target; arbitrary passwd accounts
 * are deliberately not selected by heuristic.
 */
export function selectChromiumIdentity(
  options: ChromiumIdentitySelectionOptions,
): ChromiumIdentityDecision {
  if (options.platform === "win32" || options.effectiveUid !== 0 || options.noSandbox) {
    return { kind: "inherit" };
  }

  const matches = (options.passwd ?? "")
    .split(/\r?\n/)
    .filter((line) => line.split(":", 1)[0] === STREAM_BROWSER_ACCOUNT);
  if (matches.length !== 1) return unavailableIdentity();

  const fields = matches[0]!.split(":");
  if (fields.length !== 7) return unavailableIdentity();
  const uid = parsePosixId(fields[2]);
  const gid = parsePosixId(fields[3]);
  if (uid === undefined || gid === undefined || uid === 0 || gid === 0) {
    return unavailableIdentity();
  }

  return { kind: "drop", username: STREAM_BROWSER_ACCOUNT, uid, gid };
}

/** Apply POSIX owner/group/other execute-bit selection for one directory. */
export function canIdentityTraverseDirectory(
  identity: { uid: number; gid: number },
  directory: { uid: number; gid: number; mode: number },
): boolean {
  const executeBit = directory.uid === identity.uid
    ? 0o100
    : directory.gid === identity.gid
      ? 0o010
      : 0o001;
  return (directory.mode & executeBit) !== 0;
}

/**
 * A root-created profile is safe beneath a shared path component only when
 * root owns that component and unprivileged writers cannot rename entries
 * belonging to another uid. The sticky bit supplies that protection for a
 * conventional 01777 /tmp.
 */
export function isSafeSharedTempDirectory(
  identity: { uid: number; gid: number },
  directory: { uid: number; gid: number; mode: number },
): boolean {
  const unprivilegedWritable = (directory.mode & 0o022) !== 0;
  const sticky = (directory.mode & 0o1000) !== 0;
  return directory.uid === 0
    && canIdentityTraverseDirectory(identity, directory)
    && (!unprivilegedWritable || sticky);
}

function parsePosixId(value: string | undefined): number | undefined {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_POSIX_ID ? parsed : undefined;
}

function unavailableIdentity(): ChromiumIdentityDecision {
  return {
    kind: "unavailable",
    reason:
      "Sandboxed streaming Chromium cannot start while mcp-vscode runs as root because "
      + "/etc/passwd does not contain exactly one safe unprivileged node account. "
      + "Add node with a non-zero uid/gid or run mcp-vscode as a non-root user. "
      + "MCP_VSCODE_STREAM_NO_SANDBOX=1 is an explicit unsafe last resort and is never enabled automatically.",
  };
}
