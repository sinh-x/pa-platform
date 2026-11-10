# PAP-273 follow-up: native confirmation and branch bridge

Implementation base: clean ticket worktree `9146808187a8e889d08246fa894491657c7f571c`.
Current request authorizes implementation, committed by phase, followed by a new
trial suffix. No install, config activation, remote mutation or real-ticket effect
is performed by source tests.

## Requirements and scope

Native approval: d-199e82 `PAP-273-native-approval-draft-r001.md`, SHA-256
`7f236a6ad667e595e4a952a9405fa876e9c56212e6ffc9eb30754dd63dab0d39`;
subsequent approval comment `c-20261110002734582`. One native TUI interaction may
itself be the final decision; no attestation of earlier chat or second final
confirmation. JSON path/schema and command spelling are implementation designs.

Branch behavior approval: `c-20261110003010197`; formalization
`PAP-273-branch-bridge-requirements-r001.md`, SHA-256
`12c6fc9fc0602473f7fc79e7f0c408b0130166fc11d2afcb778b9d8d104e6279`.
Approval covers the preceding behavior proposal, not native exact-byte approval
of later elaboration. The bridge observes existing links through existing owners;
no branch/resource preparation, silent repair, custody or launch rights.

Historical r006, approved earlier amendment, v1/v2 sessions and issued decisions
retain their original meaning. PAPC-077 owns external process/composition changes;
PAP-285 owns selected-config/provenance design.

## Phases and source validation

1. A1: native registry event version, finite scopes, deterministic immutable JSON,
   ticket reference/comment reconciliation, unchanged consumer protections.
2. A2: new explicit fresh Pi profile, single native interaction, same service for
   model tool and operator slash command, exact caller/source/CAS checks.
3. A3: read-only existing-owner branch verification with specific findings.
4. A4: focused regression/recovery/tamper/dispatch cases, typecheck/build,
   verifier ownership/completions, source qualification report and trial suffix.

Focused commands: core build before source adapter tests; then
`node --import=tsx --test packages/pa-core/src/__tests__/document-*.test.ts packages/pi-pa/src/__tests__/document-*.test.ts`.
Keep prior broad failure/timeouts and installed qualification gaps separate.
Use explicit bounded timeouts for broad checks; no required skip is a pass.

## A1 delivered

The existing append-only document journal now accepts explicit
`pa-document-confirmation/v1` events. New actions `confirm` and `confirm-revoke`
require a native confirmation-capable host; retained v1/v2 cannot acquire it.
Scopes are content, publish, publish-and-queue; consumers check them natively.
A content-only decision cannot publish or queue. Revocation is append-only and
does not erase prior JSON or completed effects.

The durable issued event is also the JSON/linkage intent. Exact retry identity
includes immutable subject, original journal revision, scope/operation and revoke
target. Lost file/ticket replies reuse the issued decision without another UI;
status/show exposes original request coordinates. Changed requests need current
CAS and a fresh native review. The JSON is a deterministic UTF-8 pretty-JSON
representation with trailing newline, no own digest in its hashed bytes, under
`agent-teams/requirements/artifacts/approvals/<ticket>/<decisionId>.json`.
Registry/evidence remain authority, not file possession, hashes or ticket status.

File publication is absent-only with complete/fsynced pending bytes before a
no-replace hard link; exact native pending inode/prefix recovery handles
interruption. Aliases, foreign hardlinks and conflicting bytes reject. Ticket
links and deterministic comments use existing TicketStore APIs/mutex and require
readback. Historical primary refs are unchanged. No cross-store physical
atomicity is claimed. Managed-agent boundary, not hostile same-UID isolation.

Actual A1 results: core build and all core document tests passed, **52 passed,
zero failed/skipped**. Initial TypeScript errors (TicketStore method name and
union narrowing) were fixed before that passing run. Synthetic native callbacks
are source fixtures, not real operator approval, installed qualification or UAT.

## A2 delivered

New opt-in `document_profile: pa-document-confirmation/v3` records immutable
start `requirements-document-confirmation/v3` only for eligible fresh foreground
Pi requirements/analyze. It keeps bounded workspace/presentation capabilities.
V1 paged review and V2 unavailable capture remain unchanged; neither current
config nor tool JSON upgrades old sessions. New native actions are `confirm`
(sha256, original expectedRevision, scope) and `confirm-revoke` (sha256,
original expectedRevision, decisionId). `/pa-approve <strict JSON>` invokes that
same native service, not a subprocess/receipt or a separate approval mechanism.

The trusted extension's custom terminal screen provides overview, complete
immutable document tabs and optional technical/companion-link tabs. Tab/scrolling
is reading, not page acknowledgements. One selection records approve, changes,
reject or cancel; default selection is Cancel. No typed hash, preceding-chat
attestation or second final approval. Caller/source/journal checks run after UI.
No-UI/RPC/retained-profile/abort cases fail without approval. Terminal controls
and bidi-control text are neutralized in this new view. Local UID/TUI remains
managed-agent provenance, not independent human identity or hostile-UID isolation.

Actual A2 checks: core build + adapter direct typecheck passed; new native UI,
command/tool equivalence, rejection/abort/caller and dispatch tests **9 passed,
zero failed/skipped**. UI keyboard events are disposable synthetic test inputs,
not genuine human approval or visual/readability UAT. Shared command messages
lead with decision/linkage outcomes; failures preserve possible partial issuance
and route same-request inspection, not blind retries or duplicate approvals.
