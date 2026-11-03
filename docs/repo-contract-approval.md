# PAP-273 phase 4 — operator contract approval

Source implementation, not installed availability, actual operator adoption,
execution readiness, independent review or human UAT. The phase-3 fixed catalogue
schema/path remain unchanged. No real machine credential or repository approval
was initialized during development; tests use disposable synthetic stores.

## Operator CLI (PPA or pa-core, outside agents)

- `repo-setup credential init`: new password twice, once per local operator/machine.
- `repo-setup credential rotate`: old password plus new password twice; retain approvals.
- `repo-setup credential reset`: explicit RESET confirmation and new password twice;
  invalidate **every** saved repository approval, retaining historical evidence.
- `repo-setup approve <registered-key>`: display actual parsed catalogue, exact raw
  digest, fixed file set/root and local-exclude effect; explicit APPROVE plus fresh
  hidden password. Runtime rechecks actual bytes, repository and exclude snapshot.
- `repo-setup revoke <registered-key>`: explicit REVOKE and fresh hidden password.
- `repo-setup status <registered-key>`: observation only, never execution readiness.

No password/grant/root flags, environment secret, pipe input, --yes, password
cache or agent-callable approval exists. Secrets require a real TTY transport;
echo is disabled before the prompt and the previous raw/flow state is restored.
Returned input buffers are cleared. JavaScript/OS copies cannot be guaranteed
zeroized. Synthetic PTY testing is functional transport evidence, **not human UAT**.

Native mutation rejects known PA environments, known Pi/OpenCode ancestors and
registered managed process lineage even when a child clears its environment.
Pi/shared safety and OpenCode fallback guards deny approval/credential shell
commands; protected native evidence paths remain blocked. TTY, passwords, file
permissions and lineage inspection are defense-in-depth for managed agents, not
an OS isolation boundary against arbitrary hostile code under the operator UID.
No separate OS approver service is claimed.

## One native evidence owner

Authority uses the existing `ProtectedWorkflowStore` immutable native journal at
`~/.local/share/pa-platform/prepared-autonomy/repository-contracts`, anchored to the
OS user's home, not a public argv/environment override. No extra ticket registry,
config registration, approval paragraph or parallel ledger is used. Trusted
source test constructors accept disposable dependencies; public CLI/tool inputs
cannot choose these dependencies.

Credential records contain a random 256-bit salt, scrypt N32768/r8/p1 256-bit
verifier, random approval epoch and immutable hash-chained sequence. No plaintext
password is persisted. Verification uses constant-time comparison. Normal
rotation keeps the epoch; reset changes it, so all old approvals immediately fail
consumer checks without deleting history. Immutable no-clobber sequence writes
supply CAS: a credential race fails, never overwrites. Same-UID rollback/tampering
is outside the selected managed-agent security boundary.

Repository approval/revocation records bind registered physical key/root, exact
raw catalogue digest, credential epoch and immutable predecessor/sequence.
Missing/revoked/reset/stale/malformed/insecure records and deleted/changed
catalogues cannot fall back to a legacy registration. Approval preserves catalogue
membership only; it does not authenticate a task matrix or supported executable,
confinement, custody, source scope, check result or toolchain readiness.

## Exact local Git-exclude effect

Under existing capacity and all-worktree owner exclusion, approval rejects tracked
`.pa`, aliases/hard links, unsafe metadata, pending setup temporaries and legacy or
linked-source conflicts. It appends only the absent exact `/.pa/` line to the real
primary Git local exclude, preserving existing bytes and mode. No `.gitignore`,
source, index or untrack operation is offered. Publication uses private temporary
bytes, fsync, rechecks, exclusive creation or atomic replacement and readback.
Actual ignored/untracked status must pass; conflicting project negations reject
without issuing approval or silently editing them. Partial exclude effects and
uncertain native temporaries are retained, never guessed successful or rolled back.
Consumers recheck actual ignored status; unrelated exclude additions alone do not
change the approved catalogue bytes.

## Verification and next phase

Operator/PTY targeted entry: 14 tests passed, zero skips/failures. It covers
rotation, reset across multiple repositories, reset/publication race, revoked or
deleted bytes, metadata conflicts, CLI framing/secret clearing, origin denials,
actual echo-off/TTY restoration/fresh second input and shared safety wrappers.
An initial PTY test exposed a resumed-stdin shutdown hang; restoring the original
flow state fixed it and the complete targeted entry passed. Other retained CLI
fixtures have two explicit optional external-config skips, not native passes.

Installed verifier adds both test files and two mandatory groups (27 qualification
rows); that edit is **not** an installed result. Next source phase integrates the
approved catalogue with actual task-required checks and the existing restricted
executor, retaining unchanged legacy all-check semantics. At this phase alone the
Pi legacy source guard still rejects every local catalogue, even an approved one.
PAPC-073 must use this exact source grammar only after joint packaging/selection
and actual native host qualification; operator approval is never run by setup.
