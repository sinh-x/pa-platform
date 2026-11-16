# PAP-299 reader-worker continuation

This is source progress after the review of `9b1cb43`, not implementation
completion, independent approval, installed qualification or permission to merge.
The operator chose **finish implementation before PR**. The distinct selected
handoff review/publication route, association/intake, advanced lineage reuse and
trusted packaged launcher remain required. No new capability/profile/tool is
registered by this phase; retained `pa_document` presentation is unchanged.

## Source owner changes

- `documents/reader-worker.ts`: fixed packaged derivation entry. Input consists
  only of a parsed document package and bounded immutable member bytes. Source
  paths are link metadata, never filesystem-read instructions. No publication,
  browser, authority, executable/argv/URL or callback import exists in its packet.
- `documents/reader-worker-owner.ts`: external 30-second wall watchdog around a
  real Node worker, empty environment, no inherited execution arguments, fixed
  worker location, V8 heap/stack limits and bounded unexpected stdout/stderr.
  An immutable package copy and separately owned transferable byte buffers keep
  the original journal/member buffers intact. At most two workers can run here.
- The worker is terminated on deadline/cancellation. No usable bundle is returned
  until its actual exit and complete inventory validation. A separate 2-second
  cleanup budget returns `DOCUMENT_UNCERTAIN` if exit cannot be proven, retains
  the handle and blocks all further reader workers in this process until that
  worker's exit event. It never substitutes a successful cancellation or retries
  an uncertain worker. This uncertain-termination branch is source-reviewed but
  not fault-injected by the current tests.
- `documents/reader-publication.ts`: the existing new full-reader publisher is
  now asynchronous and obtains its bundle only from this worker owner. Deadline,
  cancellation and output-limit failures before publication write no intent,
  entry or completion result. Private no-replace/pending-prefix recovery and
  completed-output fail-closed readback remain in the same publication owner.
- New read-only `inspectFullDocumentReader` re-derives native output under the
  same finite ceiling and verifies every output plus the exact completion record
  before returning a native-derived entry. It accepts a delivery digest, not a
  caller path, URL or receipt, and never repairs missing completed files.
- Delivery implementation identity now includes actual worker/owner bytes as
  well as renderer, escaping/token renderer and parser bytes. Old immutable
  delivery folders are not overwritten. A differing renderer closure produces
  another delivery identity rather than silently reusing an old approval.

The controls are trusted internal cancellation/ceiling reducers, not new model
request fields; they cannot increase either published ceiling. Node worker heap
limits do not establish a whole-process/RSS or image-decoder qualification.
The hard worker budget covers isolated derivation, not a claim that arbitrary
trusted snapshot callbacks or all filesystem durability operations are
interruptible. No deployment lifetime timeout is reintroduced.

## Actual checks

- Workspace `corepack pnpm typecheck` and `corepack pnpm build`: exit 0.
- Eleven focused core suites: **99 passed, zero failures/skips**, including the
  handoff contracts, native Git/ref composition, ticket transaction/recovery,
  full reader/worker/opening, retained presentation/confirmation/publication and
  conservative interaction catalogue.
- Seven new worker tests use real worker threads, not a supplied fake receipt:
  exact deterministic complete bundle; actual worker deadline/exit with no
  publication; live-worker cancellation/exit; ceiling-increase/pre-abort
  rejection; derived-output failure with no publication; read-only exact bound
  inspection; and maximum 64-member/>15-MiB input with every raw/fallback member
  retained under the 64-MiB/30-second derivation ceilings.
- The initial isolated 17-test reader run also passed; its near-ceiling test took
  approximately 1.66 seconds on this host. That is a measured source fixture,
  not browser observation, installed acceptance or a universal performance bound.
- `git diff --check`, workspace `corepack pnpm completions` and staged
  `corepack pnpm secrets:scan`: exit 0. Tracked completion bytes are unchanged.

Local logs: `/tmp/pap299-reader-worker-{typecheck,build,focused}.log` and
`/tmp/pap299-reader-worker-tests.log`. These are ephemeral software-test records,
not signed native review/approval evidence.

## Message and qualification boundaries

Before: cooperative elapsed-time checks could only notice a limit after
synchronous rendering returned. After: the publisher uses an external worker
watchdog and exposes no output on a failed/uncertain worker. Existing machine
error codes are reused; no new human-facing CLI diagnostic, exit/stream contract
or native confirmation receipt is introduced. Human readability review,
browser/Obsidian/accessibility observation and human UAT were not performed.

This does not resolve the selected Pi documentation/host-access denial or approve
any new API/effect. The source-pair `RUNTIME_SHELL_LIFECYCLE` failure and previously
incomplete aggregate/retained/CI/installed/human lanes remain unresolved. It does
not justify PR readiness, push, merge, ticket completion or installation.
