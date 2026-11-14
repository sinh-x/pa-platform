# PAP-299 native-owner continuation — d-f0ea21

Partial source work, **not enabled or accepted end-to-end**. Original implementation
branch and base `469e0bf6b12cadd79ddc06a3e050a13760a88e0c` retained.

## Selection freshly observed (2026-11-14)

- Clean initial HEAD `8820155849633574aa5fad8bc49d5f171faf39ef` in the authenticated
  `/home/sinh/.treehouse/pa-platform-cdb114/11/pa-platform` checkout.
- PATH PPA `0.1.166-pap302.2`, resolved executable
  `/nix/store/2fc761301831bzacgk7zjcrywkyqf91k-pa-platform-0.1.166-pap302.2/bin/ppa`.
- PATH Pi `1.4.0`, resolved executable
  `/nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0/bin/pi`.
- User configuration selects `~/git-repos/sinh-x/tools/pa-platform-config`.
  Version/PATH facts do not prove the live loaded transport or installed PAP-299
  behavior. This source branch has not merged newer PAP-298/PAP-302 source.
- A **new current** read of the selected Pi README was denied by
  `LOCAL_SOURCE_UNSUPPORTED_FILE`: qualified selected-document eligibility was not
  established. No alternate reader, copied document or older documentation was
  used to bypass it. This is separate from the historical d-61f2e6 denial.
- `ppa decision show/verify --ticket ... --id ... --json` returned
  `WORKFLOW_SOURCE`, gate `admitted-run`; that CLI route does not verify these
  document decisions in this deployment. No historical JSON was substituted for
  native verification. No dependent live publication/branch/queue effect ran.

Fully read both original checkpoint/design docs, d-61f2e6 wrap-up, all four PAP-299
r002 and PAPC-079 r003 members, and PAPC-079#c-20261113010433988. Historical scopes
remain content/publication/queue only, never new branch authority.

## Phase A: actual TicketStore finite transactions

`src/tickets/handoff-intent.ts` and `TicketStore.applyHandoffWithIntent` implement
native ticket persistence, not a second parser-only fixture: original immutable
intent -> candidate ticket -> audit -> full readback under the existing mutex.
The finite alternatives are native planned intent, correlated materialized result,
and analysis/review/changes-requested lifecycle pairs. No generic patch, queue,
primary-demotion, terminal or checkout operation is exposed.

The complete native branch intent retains the reviewed base/provenance separately;
legacy planned linkage remains SHA-free. Materialization preserves original
linkedAt/linkedBy and never infers original base from a current head. Foreign and
legacy uncorrelated planned names are not adopted. Full-ticket CAS, unfinished
same-ticket operation barriers, original-operation replay and no-rollback recovery
preserve intervening work. Native adapter hooks must independently authenticate
association/current and historical owners, authority and actual correlated refs
inside the lock. These hooks are trusted source seams, not public grants.

**Still missing:** selected native adapter/profile, independent association intake
composition, genuine new handoff review/decision/publication consumer, production
ref/lock integration and qualification. No retained tool is connected or widened.

### Actual Phase A checks

- First core typecheck failed: TypeScript did not narrow an optional intent after
  an arrow-function `never` call. Made the early rejection an explicit return;
  no validation was removed. Second core typecheck exit 0.
- New handoff + retained planning/create suites: **36/36**, zero skips/failures.
- New handoff + retained linked-branch + branch core/contracts: **43/43**, zero
  skips/failures. Includes actual separate-process ticket-mutex races, all three
  ticket persistence fault boundaries, original reply-loss replay, malformed
  self-reference, revoked/async hooks, legacy-plan collision and preservation.
- `git diff --check` exit 0. Staged secrets-scan result belongs to the commit step.

Human-facing paths: only new finite-owner errors, not an installed CLI path.
Before: no such owner result. After: outcome-first static blocked result naming
original-operation inspection, one five-label envelope, <=2,000 UTF-16 units,
explicit read-only actor/approval/prerequisite guidance. Structural plain-text
checks passed; independent readability and actual installed propagation unrun.
No existing machine/exit/stream contract changed.

## Phase B: real shared exclusion, Git/ref correlation and combined writer

`withRepositoryRefTicketExclusion` reuses the actual ticket-slot/materialization
mutex without reserve/update/reclaim/inventory-sync APIs. Its live opaque token
expires at release. It tolerates valid idle preparation without consuming capacity,
but blocks every live/stale/uncertain ticket writer. `withRepositoryRefAdmission`
then reuses the primary and sorted linked mutation mutexes, validates physical
backlinks/inode identity and rejects all retained custody markers without cleanup.
Lock order is exclusion -> primary -> linked -> TicketStore -> synchronous SQLite.
No human dialog occurs under these locks.

`RegistryHandoffGitOwner` requires an explicitly FULL-synchronous SQLite connection
(the legacy registry default NORMAL is NOT silently upgraded), stores a random
256-bit marker bound to the original operation/intent before compare-and-create,
and verifies the exact zero-old-OID creation reflog entry, base and physical
identity. Fixed bounded Git argv disables executable hooks/ambient Git config and
uses no-deref absent-only update-ref. Existing/symbolic/foreign/deleted/uncertain
refs and leftover logs block; storage symlinks reject before mutation. Exact ref,
reflog and generated ancestor directories are fsynced. No extra Git correlation
ref is created. An armed intent with absent ref is uncertain, never auto-recreated.
Power-loss/filesystem-ordering and hostile-same-UID guarantees are NOT claimed.

`completeNativeHandoffBranch` now composes the actual Git owner, SQLite branch
journal and TicketStore result writer. It consumes an exact completed native plan,
not caller lineage by name. Candidate ticket fields with a missing audit are NOT
completed linkage: recovery re-enters the original ticket operation/CAS and finishes
its audit before the branch journal can complete. This prevents reply-loss from
leaving an invisible unfinished ticket operation. Real external decision,
publication, current caller/selection and ownership checks remain mandatory trusted
native authority seams, **not implemented selected review consumers**. Fresh-create
only; existing advanced lineage migration remains unsupported (never adopted).
No new module is exported from core's public index or registered as a tool/profile.

Actual checks: core typecheck exit 0; combined owner/new-ticket/retained branch,
Treehouse concurrency, repository-admission and repo-setup suites **144/144 passed**,
zero skipped/failed/cancelled. Includes real child-process SIGKILL after ref create,
actual competing capacity process exclusion, all ticket crash boundaries through
the combined adapter, original marker readback, symlink/leftover-log negatives,
retained primary/linked custody and unchanged idle reservation bytes.

Preserved earlier Phase B failures: initial typecheck found missing explicit string
annotations on frozen port parameters (corrected); first Git tests 0/9 passed
because the shared fixture had legacy NORMAL synchronous mode (correctly rejected;
fixture now explicitly uses FULL, production check retained). Next run 8/9 passed:
child script imported bare better-sqlite3 outside its workspace package resolution.
Changed the child to use the actual registry owner and explicitly FULL connection;
SIGKILL assertion and all original correlation checks retained. Reruns 13/13 and
final expanded 144/144 passed. No failed run is represented as a pass.

Full source/paired checks, independent review, hosted CI, installed/default-entry,
foreground prompt counts, browser/accessibility and TS1–18 human UAT/adoption are
separate outstanding gates. Prior timeout/skips remain as recorded, not passes.
No installation, config mutation, push/merge, ticket completion or checkout return.
