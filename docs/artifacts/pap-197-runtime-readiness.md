# PAP-197 runtime readiness evidence index

## Status: NOT READY / NOT ENABLED

This is a **source-phase delivery**, not installed-output/browser acceptance.
PAPC-020 remains the consumer; no PAPC settings, instructions, skills or templates
are changed. Parent acceptance, independently authorized exact-candidate review,
CI, human UAT, merge and ticket gates remain separate. Critical/Major counts have
not been independently assessed; no zero-findings or AC acceptance is asserted.

The implemented [interface v1 contract](../contracts/lavish-artifact-review-v1.md)
is normative for consumers, not proof that the runtime meets it. Unsupported:
macOS, Windows, aarch64 native execution, public/Tailscale sharing, credentials,
external assets/navigation, executable document HTML, active Mermaid/whiteboard,
attachments, multi-user review and automatic approval/source edits.

## Authority and reproducibility

Sole full-matrix authority is the unchanged approved section `Full Validation
Matrix` in
`agent-teams/requirements/artifacts/2026-10-15-pap-197-lavish-artifact-review.md`
(under the operator's ai-usage root), raw-section SHA-256
`cd10c9fe8b2554640c8c5611069e8ea0d30940e07589ee0fdfae48d3fac3590c`.
Approval evidence: `PAP-197#c-20261015091231229`. This index neither changes its
nine commands nor issues a review authorization. Only a separately admitted,
launch-bound independent review may execute that matrix at its exact Feature
SHA. The implementation worker executed **no full matrix** and no installed or
browser suite. Do not infer acceptance from a branch name or mutable checkout.

Committed candidate identity is the Phase 4 commit recorded in the external
worker report; final NUL-safe Git status and full commit SHA live there, avoiding
a self-referential commit hash in this document. Baseline was clean
`a5d7c69dba6cd1613a2a8563c6daabdd80ef7618` on
`feature/PAP-197-lavish-artifact-review`. No dependency/lock/pin, renderer CSP,
authority-file or requirements/matrix edits are part of this source phase.

## Evidence actually produced in Phase 4

External immutable-by-content receipt directory:
`/home/sinh/Documents/ai-usage/deployments/d-3bf926/phase4-evidence/`.
Every command has `.json` complete argv/cwd/start/end/exit/duration, `.stdout`
and `.stderr`; failures are retained, never replaced with later success.
Parent-facing report:
`/home/sinh/Documents/ai-usage/deployments/d-6201cf/phase-4-worker-report.md`.

| evidence | scope / limit |
| --- | --- |
| `native-lavish-build.*`, `native-review-syntax.*`, `native-provenance.*`, `native-asset-reader.*` | Actual original Phase 3 Lavish derivation build, generated-JS syntax and digest/immutable-reader checks; no upstream CLI/server/UI execution |
| `debug-false-ack-before.*`, `debug-false-ack-after.*` | Reproduced a false durable-ACK notice after pinned submit returned false (0/1 before, 1/1 after); source VM/DOM hook regression only |
| `native-lavish-corrected-build.*`, `native-corrected-review-syntax.*`, `native-corrected-asset-reader.*` | Actual correction-checkpoint derivation build/syntax/digest checks; still not installed PA or browser behavior |
| `native-final-build.*`, `native-final-syntax.*`, `native-final-assets.*` | First staged native build/syntax passed; full helper verification found missing installed generate-inventory.py (retained failure) |
| `native-final-fixed-build.*`, `native-final-fixed-syntax.*`, `native-final-fixed-assets.*` | Final staged-candidate native Lavish build/checks after copying that recorded provenance helper; exact output/source binding is external to avoid self-referential store references |
| `focused-artifacts-corrected.*` and later final focused regression | 60/60 artifact render/manifest/session/feedback/policy source tests; synthetic loopback and explicit fault seams, not installed/browser completion |
| `debug-matrix-selftest.*`, `debug-harness-*.{json,stdout,stderr}` | Real harness parsing/accounting/rejection/receipt/observer/CDP transport and Fish completion self-tests; no simulated installed case counts |
| `final-v4-1.*` through `final-v4-5.*` | Final exact ordered Phase 4 checks after native provenance packaging correction; all earlier final sequences are retained, not overwritten |
| `staged-secrets-scan.*`, staged diff/status/snapshot receipts | Scoped staging and independent staged scan before the sole Phase 4 commit |

### Concrete prerequisite corrections and immutable native output

1. `pkgsStatic.stdenv` adds the target to the store basename. Native original
   output was
   `/nix/store/sc7aibhzzck5w47xd33znfwxdgycb1g3-lavish-axi-static-x86_64-unknown-linux-musl-0.1.67`;
   the old `*-lavish-axi-0.1.67` validator rejected it. Core now accepts only the
   exact static x86_64/aarch64 musl names and retains fd-relative non-symlink,
   root-owned, non-writable store-file/directory checks. No writable path fallback.
2. Pinned submit's HTTP 409 path returns `false` without consuming the queue.
   Outer glue formerly overwrote that refusal with “Durably acknowledged”. A
   focused regression reproduced it; glue now preserves refusal/ended semantics.
   `adaptations.json` records the new outer.js digest/reason. Pin, server ACK,
   source CSP and queue durability policy are unchanged.
3. General CLI help/completions still described the Phase 2 placeholder
   lifecycle as unavailable. Metadata now describes selected-runtime/ownership
   prerequisites, without advertising readiness. Real Fish grammar tests cover
   nested operations/options and protected-review/deployment-status collisions.
4. Full installed native adaptation verification failed on a recorded helper:
   `generate-inventory.py` was hash-bound in adaptations.json but not copied to
   the closure. Nix now copies it as inert provenance (never executes it). Exact
   installed helper digests are checked in the corrected native receipt; locks,
   dependencies, other AXI exposure and the 0.1.67 pin are unchanged.

Corrected immutable native Lavish output at the correction checkpoint (before
final documentation/staging; final candidate output is in `native-final-fixed-build`
and the worker report):
`/nix/store/kbsh566bnkyhsm6d9zbs7vbi3slmslfi-lavish-axi-static-x86_64-unknown-linux-musl-0.1.67`.
Generated review.js SHA-256:
`e2d53053c88ec43b33baef43fddfc17c64473d17d5285c1bda78cbbb142216db`.
Original archive SHA-256:
`b04bd8eea71ece824ca5dc6837c98de04372b76ca6a28fe6e1a1ab025e50acfd`.
Full original-source/helper/license/transitive digests are in
`nix/axi/lavish-axi/{upstream-files,adaptations,integrity}.json` and the immutable
installed `share/lavish-axi/review/provenance.json`. Only this one logical Lavish
package was built, before and after the narrow correction; **zero of the sixteen
PA selection builds** were run here. Normal declared Nix fetchers were used;
no manual npm provisioning or raw upstream execution occurred.

## Implemented validation entrypoints — NOT execution evidence

These match commands 7–9 of the unchanged approved matrix:

```sh
python3 scripts/lavish-smoke/matrix.py --system x86_64-linux --output "$PA_LAVISH_EVIDENCE_DIR/installed"
node scripts/lavish-smoke/runtime.mjs --inventory "$PA_LAVISH_EVIDENCE_DIR/installed/inventory.json" --output "$PA_LAVISH_EVIDENCE_DIR/runtime"
node scripts/lavish-smoke/browser.mjs --inventory "$PA_LAVISH_EVIDENCE_DIR/installed/inventory.json" --chrome "$PA_LAVISH_CHROME_EXECUTABLE" --output "$PA_LAVISH_EVIDENCE_DIR/browser"
```

Do not run these outside the independent matrix authorization. Same-shell
prerequisites, exact candidate SHA, network policy and dependency/browser
provisioning belong to that authority. Evidence output must be an absent
canonical absolute directory outside the checkout, under the authorized private
evidence root. No existing result is overwritten into a passing result.
Missing prerequisites, incomplete reports, unknown/duplicate/omitted/skipped
cases, failed cleanup or observed forbidden attempts all fail closed.

### Installed inventory: 113 required cases

`inventory.json`, schema `pa-lavish-inventory/v1`, contains `status`,
`featureSha`, `flakeLockSha256`, `versions`, `commands`, `outputs` (mask strings
0..15 to exact native store paths), `evaluations` (`system/mask`), `tools`
(version/drv/store/node/dependencies/closure/record digests), `inspection`
(flake-locked bwrap/strace), `requiredCases`, `cases`, `counts`, `missingCases`,
start/end timestamps and a failure condition when applicable.

Enumeration is executable `required_cases()` in matrix.py:
- prerequisites (native host, sandbox, clean exact candidate, versions);
- 32 evaluations (all 16 selections on each Linux system), with aarch64
  **evaluation-only**, including default/Lavish/single/all selections;
- 40 invalid-boolean evaluations (4 selectors × 5 invalid types × 2 systems);
- 2 default/alias/overlay checks;
- 16 native PA selection builds and 16 installed selection/environment checks;
- 5 exact pin/transitive/license/adaptation inventories and inspection tools.

Installed environment checks execute real makeWrapper shells and installed
adapter constructors. They capture all three adapters' foreground/background ×
spawn/resume launch environments (12 per selection, 192 total), including exact
PATH/PA_AXI_PATH and owner metadata. Only PPA gains other selected AXI prefixes.
**Launch capture seams are not real provider/inference or background-runner
acceptance.** They are explicitly scoped evidence, supplemented by real installed
artifact CLI lifecycle operations in the next harness; they cannot by themselves
prove an entire deployment supervisor path. Only the interpreter-capture helper
from axi-smoke is reused; its old three-selector/PPA lifecycle/provider suite is
not relabeled as Lavish coverage.

### Installed runtime: 65 required cases

`results.json`, schema `pa-lavish-results/v1`, has role/status, required-case IDs,
cases with evidence, exact counts/missing IDs, command receipts, original and
final process/file/listener inventories, artifacts' complete digests, measured
budgets, cleanup failures and final kernel observed-effects audit. Worker-only
`worker-results.json` is **provisional** until the outer observer verifies it.
No worker JSON or fixture result alone is passing observed-effects evidence.

For **each** ppa/opa/cpa, executable `runtimeKinds` enumerates:
1. deterministic render/manifest repeat (CRLF/Unicode and supported/inert syntax);
2. inclusive 2 MiB/over-limit source boundaries;
3. invalid UTF-8/non-regular source;
4. symlink/ancestor/existing destination/source-alias paths;
5. strict grammar and unsafe inherited environment;
6. unselected runtime/missing owner before effects;
7. malformed/symlink companion;
8. partial-startup failure bound/owned transient cleanup (installed API fault seam);
9. real owned supervisor interruption, recovery and acknowledged feedback;
10. lifecycle/status/idempotence/permissions/no-feedback/default timeout;
11–14. source/HTML/manifest/version staleness with journal preservation;
15. real installed durable feedback, retry, export conflicts/symlinks, stop/restart;
16. malformed/cross-source/changed-ID and UTF-8 feedback/selection limits;
17. foreign adapter/deployment and PID reuse without guessed signals;
18. concurrent isolated sessions with an occupied unrelated listener;
19. durable human end and rejected automatic reopening;
20. real ancestor exit and <=5s cleanup preserving acknowledged journal;
21. actual **900-second elapsed idle**, independently measured for all adapters.

Two additional cases exercise installed journal fsync/rename/ACK and export
fsync/link boundaries, event/byte caps, and exact installed clock boundaries.
Clock/fault seams supplement, never replace, real installed CLI lifecycle,
real-time idle or browser UI. No OS-crash coverage beyond the recorded injections
is inferred. Idle clocks run concurrently, with real status polling that must
not prolong lifetime; no timing acceleration or environment assertion is proof.

### Browser: 47 required cases

Exact Chrome executable/realpath/version/digest, disposable sandboxed profile,
actual chrome://sandbox feedback and kernel exec evidence are prerequisites.
CDP uses inherited pipes, not a public debugging listener or an npm driver.
Every adapter's `browserKinds` enumerates walkthrough; real trusted mouse text
selection; element feedback; stable export retries/server restart; oversized
real UI send retaining unsent text; stale-race rejection without false ACK and
freeze; user end; CLI denials; absent forbidden UI plus browser-origin probes;
HTTP denials; WebSocket denials/closed sockets; Host/Origin; file confinement;
inert hostile content/offline retained rendering; listeners/process/state modes.
The two cross-adapter cases are browser prerequisites and zero-egress accounting.

Required outputs: `results.json`, `network.json`, `screenshots/`, raw
`effects.strace`, Chrome stdout/stderr/command receipt, sandbox text and worker
report. Unknown and pinned upstream share/export/poll/session/file/design/SDK/
attachment/whiteboard/layout routes are probed with GET/POST/PUT/DELETE and valid
WebSocket upgrade handshakes; raw paths/Host headers avoid fetch normalization.
Source/companion/authority/read sentinels, real exported events, DOM execution
sentinels, before/after processes and listeners remain in external evidence.

The outer observer runs in fresh network/PID/mount namespaces exposing only
immutable store, harness code, disposable temp/dev/proc and owned evidence; it
mounts the exact operator browser entrypoint, never an operator profile. It
captures attempted **and** successful syscalls before auditing: network isolation
or failed connection is not counted as zero attempted egress. No CDP request
interception, resolver substitution or proxy hides attempts. All forbidden IP
attempts/successes, non-loopback binds, credential discovery, protected source
writes, out-of-bundle file attempts, sentinel access and foreign signals fail.
A public-system-metadata/read allowlist and private temp/proc-fd allowances are
explicit in `auditTrace`; raw traces and snapshots must still receive independent
boundary review, not an unsupported claim that string parsing proves all security.
A quiescent owned PID namespace and no remaining listeners are asserted before
namespace teardown, not manufactured by teardown.

**Observation prerequisite blocked on the current host:** a standalone parent
bubblewrap/Node probe, both with the observer flags and with explicit user
namespacing, returned UID 65534 for its root-owned immutable Nix executable
(mode 0555). Thus merely omitting `--unshare-user` does not preserve host-root
ownership here. The unchanged coreutils/asset and observer admission reject that
mapping; no overflow-UID/writable-store exception or privilege bootstrap was
introduced. Exact argv/timestamps/exits and scope are in
`deployments/d-6201cf/environment-preflight/` under the operator's ai-usage root.
This is a measured local prerequisite incompatibility, not an installed runtime,
browser or matrix result. Provide a trusted compatible observer environment, or
obtain a separately reviewed security-preserving design decision, before actual
independent validation. Do not silently change host policy or count this as pass.

## Bounded engineering corrections (not acceptance)

SI-1–SI-4 from the parent's static Phase 3 inspection remain applicable to the
Phase 4 baseline. Corrections serialize/recheck dead-stop and startup-timeout
cleanup plus supervisor transitions; replace unrecoverable mkdir locking with
crash-released private regular-file flock; complete pinned-parent publication and
identical-export retry fsync barriers; and allow authenticated stale End while
feedback/export stay frozen. Failed End confirmation is explicit. SI-5's existing
409 false-return/retained-queue correction is preserved and regression-tested.
Legacy directory locks and foreign/malformed lock files fail closed without
removal; there is no guessed PID/age recovery. Production uses the fixed installed
util-linux symlink, not an environment or PATH executable.

Focused synthetic regression, native generated-asset and final phase-check
receipts/findings dispositions are external:
`/home/sinh/Documents/ai-usage/deployments/d-6201cf/findings-correction-report.md`
and `deployments/d-190004/correction-evidence/` under the same ai-usage root.
Parent follow-up also reproduced a stale idempotent-start success after a
concurrent ended-state publication. The reuse path now revalidates generation,
running state, process birth and artifact identity after its asynchronous control
handoff instead of returning the old admission snapshot. The deterministic
publication-seam regression and final focused check receipts are in
`deployments/d-6201cf/final-correction-evidence/`; this is not real browser proof.

A subsequent installed PPA smoke failed stopped-session restart with exit 6
(`deployments/d-6201cf/installed-live-smoke-retry-report.md`). Bounded diagnosis
in genuine Pi deployment `d-04eb8e` reproduced an unlinked owner-file inode during
stop polling without scheduling intervention. A separately labeled module-level
diagnostic widened the read/publication interval by 5 ms and captured the same
boundary during restart readiness: `replacePrivate`'s atomic rename changed the
pinned old inode's ctime/link count, and `readPrivate` rejected it as an ownership
conflict. This establishes a concrete runtime race, not the unknowable internal
throw site of the earlier uninstrumented CLI failure; it is not evidence against
Treehouse, Bubblewrap or the separate observer UID prerequisite.

Private reads now discard displaced inodes and reopen the current publication
with all ownership/mode/link/size/content-stability checks repeated, at most four
attempts. They never accept unlinked bytes or ignore in-place edits, unsafe
replacement files or changed owner context. The first exact-commit CLI rerun
still failed; further genuine installed-module tracing captured changed ctime
with the previous link count of 1, followed immediately by link count 0 on the
same pinned inode and a different inode at owner.json. A confirming fresh fstat
now handles that mixed-field unlink observation without accepting metadata-only
changes. Deterministic source regressions cover both stat windows, the observed
mixed-field snapshot, stopped-session restart with retained feedback, foreign
replacement context, unsafe files and bounded churn. Complete before/after,
exact-candidate installed smoke/build receipts and final commit identity are
recorded externally in
`/home/sinh/Documents/ai-usage/deployments/d-6201cf/pr-prep-restart-report.md`.
Those bounded checks are not the installed/browser matrix or UAT acceptance.

These engineering checks do not replace the approved matrix, real browser
interaction, host-crash durability proof or a compatible native observation
environment. No observer ownership/privilege policy was changed.

## Remaining gates / consumer disposition

**Not executed:** all sixteen installed PA builds, either installed runtime or
browser harness, real Chrome walkthrough/selection, actual 900s expiry, kernel
no-egress/file/signal acceptance, aarch64 evaluation matrix, complete nine-command
candidate validation, CI or human UAT. Harness source/self-tests cannot qualify
these outcomes, browser compatibility, native installed adapter parity or
Critical/Major counts. Actual failures must remain failed mandatory cases;
unsupported/ambiguous prerequisites must block, not skip-to-pass or weaken policy.

Independent review must reconcile every FR1–FR10/NFR1–NFR6/AC1–AC10 with concrete
exact-candidate evidence, complete outer count **9/9**, all mandatory subcases,
zero forbidden effects and findings dispositions. The explicit launch-capture,
fault-injection, observer and installed crash-release/durability limitations need review;
any genuine product/security scope decision goes back to the operator.
Human UAT needs one traceable scenario per AC and explicit sign-off. PAPC-020
must not enable consumer guidance merely because this contract/harness is
committed. Feedback reconciliation uses the v1 eventId/source digest/disposition/
rationale/affected-requirements/renewed-approval record; it grants no authority.
