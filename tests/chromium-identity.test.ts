import assert from "node:assert/strict";
import test from "node:test";
import {
  canIdentityTraverseDirectory,
  isSafeSharedTempDirectory,
  selectChromiumIdentity,
} from "../src/runtime/chromium-identity.js";

const PASSWD = [
  "root:x:0:0:root:/root:/bin/sh",
  "node:x:1000:1000:Node runtime:/home/node:/bin/sh",
  "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
  "",
].join("\n");

test("sandboxed POSIX root drops only Chromium to the node account", () => {
  assert.deepEqual(selectChromiumIdentity({
    platform: "linux",
    effectiveUid: 0,
    noSandbox: false,
    passwd: PASSWD,
  }), {
    kind: "drop",
    username: "node",
    uid: 1000,
    gid: 1000,
  });
});

test("non-root, Windows, and explicit no-sandbox launches retain the current identity", () => {
  assert.deepEqual(selectChromiumIdentity({
    platform: "linux",
    effectiveUid: 1000,
    noSandbox: false,
  }), { kind: "inherit" });
  assert.deepEqual(selectChromiumIdentity({
    platform: "win32",
    effectiveUid: 0,
    noSandbox: false,
  }), { kind: "inherit" });
  assert.deepEqual(selectChromiumIdentity({
    platform: "linux",
    effectiveUid: 0,
    noSandbox: true,
  }), { kind: "inherit" });
});

test("sandboxed POSIX root fails honestly when node is absent or ambiguous", () => {
  for (const passwd of [
    "root:x:0:0:root:/root:/bin/sh\n",
    `${PASSWD}node:x:1001:1001:duplicate:/srv/node:/bin/false\n`,
  ]) {
    const decision = selectChromiumIdentity({
      platform: "linux",
      effectiveUid: 0,
      noSandbox: false,
      passwd,
    });
    assert.equal(decision.kind, "unavailable");
    if (decision.kind === "unavailable") {
      assert.match(decision.reason, /safe unprivileged node account/);
      assert.match(decision.reason, /never enabled automatically/);
    }
  }
});

test("sandboxed POSIX root rejects root-equivalent or malformed node ids", () => {
  for (const entry of [
    "node:x:0:1000:node:/home/node:/bin/sh",
    "node:x:1000:0:node:/home/node:/bin/sh",
    "node:x:-1:1000:node:/home/node:/bin/sh",
    "node:x:1000:not-a-gid:node:/home/node:/bin/sh",
    "node:x:4294967295:1000:node:/home/node:/bin/sh",
    "node:x:1000:1000:missing-fields",
  ]) {
    assert.equal(selectChromiumIdentity({
      platform: "linux",
      effectiveUid: 0,
      noSandbox: false,
      passwd: `${entry}\n`,
    }).kind, "unavailable", entry);
  }
});

test("temp-directory traversal follows POSIX owner/group/other precedence", () => {
  const identity = { uid: 1000, gid: 1000 };
  assert.equal(canIdentityTraverseDirectory(identity, { uid: 0, gid: 0, mode: 0o1777 }), true);
  assert.equal(canIdentityTraverseDirectory(identity, { uid: 0, gid: 0, mode: 0o1700 }), false);
  assert.equal(canIdentityTraverseDirectory(identity, { uid: 0, gid: 1000, mode: 0o0710 }), true);
  assert.equal(canIdentityTraverseDirectory(identity, { uid: 1000, gid: 1000, mode: 0o001 }), false,
    "matching owners use the owner bits even when an other bit is present");
});

test("shared temp directories must be root-owned and sticky when writable by other identities", () => {
  const identity = { uid: 1000, gid: 1000 };
  assert.equal(isSafeSharedTempDirectory(identity, { uid: 0, gid: 0, mode: 0o1777 }), true);
  assert.equal(isSafeSharedTempDirectory(identity, { uid: 0, gid: 0, mode: 0o0755 }), true);
  assert.equal(isSafeSharedTempDirectory(identity, { uid: 0, gid: 0, mode: 0o0777 }), false,
    "world-writable without sticky permits profile rename/delete attacks");
  assert.equal(isSafeSharedTempDirectory(identity, { uid: 0, gid: 0, mode: 0o0775 }), false,
    "group-writable paths also require sticky semantics");
  assert.equal(isSafeSharedTempDirectory(identity, { uid: 1001, gid: 1001, mode: 0o1777 }), false,
    "an unprivileged account must not own the shared ancestor");
  assert.equal(isSafeSharedTempDirectory(identity, { uid: 0, gid: 0, mode: 0o1700 }), false,
    "the selected browser identity must still be able to traverse the path");
});
