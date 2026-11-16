# PAP-303 P1 contract proposal — W3 draft r001

**UNAPPROVED / FEASIBILITY BLOCKED.** This is an agent-authored contract proposal,
not a supported API declaration, published requirements revision, native approval,
source-access grant or permission to implement/enable a peer effect.

Date: 2026-11-16. Deployment `d-b59414`, existing ticket worktree on
`feature/PAP-303-herdr-trusted-bridge`, retained HEAD `66629b6` plus the recorded
uncommitted W1/W2 candidate. The published PAP-303 r002 requirements/UAT remain
unchanged. [W2 evidence and source-policy conflict](PAP-303-W2-source-composition.md)
and [W1 hardening](PAP-303-W1-helper-hardening.md) are prerequisite context.

## 1. Decision summary

Preferred architecture **to investigate**: Herdr for lifecycle/discovery, plus a
supported PA-aware native agent-context receiver and explicit reply channel.
Reception must be distinct from human input and must share the host's atomic
consent/dialog/role/incarnation admission boundary. No such installed interface
has been demonstrated here. Do not emulate it with terminal input, `send-keys`,
scrollback, a generic socket/file queue or a prompt containing a stronger nonce.

Keep messaging unavailable until that boundary is evidenced and reviewed. The
current Herdr prompt/read/wait API descriptions and helper metadata do not meet
it. A lifecycle-only checkpoint is not full PAP-303 completion; any staged scope
change needs an explicit disposition rather than relaxed acceptance criteria.

## 2. Exact current evidence and missing pins

| Subject | Recorded evidence | Qualification limit |
|---|---|---|
| PPA source | Base develop v0.1.170 `9489913`, merged into this retained feature; current retained HEAD `66629b6` plus dirty W1/W2 files | Not installed source provenance, remote freshness or a reviewed immutable implementation subject. |
| Selected-host source design | `selected-pi-host.mjs`, fixed launch record/environment and private read publisher in the repository | Default-off separate host; read publication is not a peer-reception API. Existing PAP-298 qualification limits remain. |
| Pi package/API | Project dependency declares `@earendil-works/pi-coding-agent` 0.84.4; earlier installed observations report Pi1.4.0 | Inert project runner tests are not exact installed ABI/API/license evidence. Normal installed README/extensions docs reads were denied; no bypass was used. |
| Herdr source/schema | Earlier audit records Herdr0.9.5, private protocol22, Pi integration v9; 6,694-byte integration source SHA256 `2c5272d732b475bbf91a027203b1f98d25fe43d2c1402530a442b288aeaca1e4`; static fixture in the repository | Prior audit attribution, not fresh complete source/API/license/server-authentication proof. Static fixture matching does not detect upstream drift automatically. |
| NX consumer | NX-069 owns declarative package/env wiring and installed qualification | Exact selected pairing/config derivation and authorization remain unverified. No NX authority transfers here. |
| Safety/custody | W1 metadata-only observations; W2 controlled hook-order/publication tests | No receiver, consent owner, atomic all-dialog boundary or full real-host enforcement established. |

Before a reviewed contract becomes executable, replace each missing pin with
admitted exact source/API/license/privilege evidence, actual selected package and
build/config identities, and a frozen implementation subject. A version label,
CWD, pane id, root-owned store file or result marker is not that provenance.

## 3. Proposed composition and owner split

- **PA runtime:** trusted finite composition, source-aware guards, lifecycle and
  protected native reception/reply; authenticated caller/target/role/incarnation
  binding; native consent/dialog arbitration; durable reservation/recovery and
  total deadline. Preserve immutable tools and repository custody.
- **PAPC:** select only actually supported finite capabilities/defaults after the
  runtime contract is reviewed. No proposed config key is treated as implemented.
  Config cannot create a receiver, turn correlation or human approval authority.
- **NX/Drgnfly:** select reproducible compatible Pi/PPA/Herdr packages and wire the
  reviewed interface; own installed activation/rollback/diagnostics separately.
  PAP-281/PAP-286 inventory remains observation, never send permission.
- **Pi/Herdr upstream owners:** provide/review any missing native host/server
  primitives. If absent, keep the dependent effect unsupported, not emulated.

Current source lifecycle selection is `PA_HERDR_LIFECYCLE=1` plus `HERDR_ENV=1`,
`HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. It stays default off. The selected host's
finite environment omits these names, so this is not yet a qualified NX-facing
selected-host interface. Simply adding names would not establish authenticated
session/pane/deployment binding. The bridge's `herdr:blocked` listener has no PA
emitter in the inspected source; it cannot prove complete native-dialog coverage.

Managed startup must retain one `--no-extensions` plus one trusted extension
selection; no arbitrary HOME/project extension discovery. The actual selected
host/loader/final-publication behavior must be qualified, not inferred solely
from argv source or register-last ordering. Unsupported foreign-hook compositions
must be refused by the owning host boundary before a protected feature is used.

### Selected finite source policy

Sinh explicitly selected “Restore finite selected-source scope” after W2's
analysis. Ordinary reads now require a regular file with exactly one link;
store spelling, root ownership and read-only mode are not exceptions. The private
native selected-Pi route remains limited to its executing host's documentation.
Herdr audit-source access requires a separately reviewed finite contract, which
is not implemented or approved here. The earlier broad ordinary-store candidate
was withdrawn without installation. This source-scope direction resolves the
PAP-298 conflict; it is not an exact-contract approval, producer binding or
completion of P1's remaining independent/installed evidence.

## 4. Required protected submission/reception contract

The following are **required semantics**, not invented available function names:

1. A normal admitted writer A selects an already existing read-only peer B.
   Resolve both through runtime-owned deployment/process/session facts and an
   authenticated Herdr session/pane/incarnation association. Caller IDs select a
   subject; they never supply its truth, role or permission.
2. Native operator consent binds this exact live pair and request/reply purpose.
   It is revocable; restart/rebind/incarnation change ends it. A peer body, copied
   receipt, result-details marker or approval-looking string cannot create consent.
3. Receiver-side admission and enqueue share **one linearization boundary** with
   consent epoch, live incarnations, idle/readiness state, read-only role, durable
   reservation and every native dialog. Recheck at that boundary, not just during
   earlier discovery. Source-side dialogs also block the exchange.
4. Deliver the request as typed **untrusted agent context**, not a human message,
   native dialog answer, slash-command dispatch, tool call or capability grant.
   B remains unable to write through the actual admission owners, regardless of
   model persuasion. Existing sensitive-input/content policies still apply.
5. B sends an explicit typed response through the corresponding protected path,
   bound to the original request and both endpoints. It does not synchronously
   wait back. A alone waits; sequential R2 is A→B only after safe settlement.
6. Only the exact native-bound response completes the exchange. Generic idle,
   `completion_seq`, echoed prompt text, terminal tail or reply label cannot.
   W1's `unverified` metadata must not be upgraded into a response by a wrapper.

Native coverage must include PA questions, document/decision confirmations,
prepared workflow/dirty-borrow prompts, handoff review and context/Git overlays,
plus applicable Pi-owned native dialogs. This is a starting source inventory,
not an exhaustive installed race audit. The host must provide the shared boundary
and lifecycle hooks; independent model checks or a Herdr status poll cannot.

**Current feasibility: BLOCKED.** No exact installed protected agent-context
reception/reply API, underlying `agent.prompt` implementation/non-terminal proof,
or atomic all-dialog boundary has been admitted and demonstrated. The next audit
must establish those facts or identify the precise upstream change required.

## 5. Finite draft message and durable-state semantics

This section constrains a future reviewed schema; it is not a registered protocol.
The exact version/package/config interface remains unselected until §2/§4 evidence.

### Application record

Use a strict versioned record with unknown fields rejected. Required request
metadata: request ID, original native intent ID, both native-derived deployment/
process/session/Herdr identities and incarnations, consent epoch and context body.
A response binds the same request/intent/pair/incarnations and an explicit response
kind/body. Human approvals, role grants, arbitrary paths/roots/argv, renderer state
and serialized process tokens are never accepted as authority-bearing fields.

IDs are correlation labels, not authentication. All claims must come from the
protected native endpoint/custody boundary, not merely be present in JSON. Do not
introduce a self-asserted `source: human`/`public-web` exemption. Credentials and
private bodies must not leak through new diagnostics or metadata.

### Settled policy — do not request these numeric choices again

- Request <=**4,096 UTF-8 bytes**. Count the complete encoded application request,
  including its envelope/routing/nonce; reject oversize intact before effects.
  W1 currently counts its whole planned JSON parameter object. Any additional
  transport record framing must fit the same budget, not be silently excluded.
- Relevant reply <=**80 lines AND 16,384 UTF-8 bytes**. Validate complete UTF-8 and
  apply the smaller ceiling at code-point boundaries. Label partial replies
  explicitly. Never collect/return unrelated terminal content.
- **One** active exchange per unordered live pair, with durable original-intent
  exclusion so new IDs/incarnations cannot evade unresolved delivery knowledge.
- **60 seconds total** monotonic requester budget for admission, reservation,
  submission, wait and read. No fresh full timeout for each stage. Stop publishing
  a new response at deadline; a timeout proves nothing about remote work stopping.
- Exact-live-pair revocable consent; restart/rebind ends it. **Zero automatic
  resend**, including lost acknowledgement, cancellation, crash and reconnect.
- No bridge-retained bodies by default. Unresolved minimized metadata/tombstones
  remain with the original owner until proven settlement; **seven days from
  settlement** for settled bridge metadata. Existing Pi transcripts/audits remain.

### Owner/state transitions

| Transition | Required durable fact and outcome |
|---|---|
| No reservation → reserved | Original native intent and unordered-pair exclusion recorded atomically before possible delivery. Refuse concurrent/self/stale/ambiguous/busy/blocked/unknown/writer targets. |
| Reserved → rejected-before-send | Native boundary proves no submission; only then may the original reservation be safely settled. An exception string or missing ack is not that proof. |
| Reserved → submitted | Boundary records its acceptance for the original request. Lost acknowledgement leaves delivery knowledge uncertain; never repeat. |
| Submitted/uncertain → replied | Only the protected identity/request-matched response may establish this result; retain delivery knowledge separately from wait outcome. |
| Any possible-effect state → timeout/cancel/uncertain | Preserve the original intent/pair exclusion and minimized recovery metadata. Process death, silence or a fresh request ID does not clear it. |
| Original-owner reconciliation → settled | Use actual finite native evidence; do not infer nondelivery from expiry. Late/conflicting replies remain linked to the original request, never satisfy a later one. |
| Settled → metadata expiry | Seven-day settled-only cleanup. Storage pressure must fail closed rather than erase unresolved tombstones or other owners' audit records. |

The proposed owner must persist the exclusion across process death/restart. It must
not hash/store request bodies or credentials as a substitute for an authoritative
original intent; unresolved pair/intent state must block new-ID escape without
retaining private bodies. Unknown cleanup cannot manufacture successful release.

The real scheduling/cleanup tolerance and exact storage/atomicity/host APIs are
**not yet qualified**. They are a P1 blocker before live use. Fixtures may prove a
model of these transitions, but cannot be presented as the actual durable owner.
No new background service, scheduler or cross-repository writer is selected here.

## 6. Six-item P1 exit table

| Published requirements §5 item | Current disposition |
|---|---|
| 1. Admitted exact source/API/license/privilege hashes, NX provenance, fresh standalone/managed loading | **Partial/blocked** — repository mechanisms and historical audit exist; exact installed sources/server internals/licenses/pairing/loading remain unavailable/unverified. |
| 2. Evidence-backed composition and exact versioned package/config interface | **Proposed only** — finite source scope is selected and default-off lifecycle source exists; exact Herdr audit-source and selected-host/NX interfaces remain unresolved. |
| 3. Proven agent-provenance submit/receive/reply and atomic all-dialog/consent/role/incarnation boundary | **Blocked** — §4 states the required boundary, not an available API or passing proof. |
| 4. Finite schemas, reservation/deduplication/uncertainty/recovery/retention/deadline owners | **Requirements/proposal only** — §5 fixes semantics and settled limits; concrete protected owner implementations are not selected or tested. |
| 5. Exact executable matrix and source/installed/default-entry/foreground pins, timing/cleanup tolerance | **Partial/blocked** — W1/W2 current source commands/results exist; real protected-receiver/installed/foreground procedures and tolerances are not executable facts. |
| 6. Blast radius, independent contract security review and Sinh's material-interface review | **Pending** — source owner analysis below is not independent review. No native exact-contract approval captured. |

A proposed contract is not P1 acceptance. Resolve every blocking row, freeze the
exact material interface and obtain its independent and human review before
dependent effect implementation. Do not repeat unchanged numeric-policy approval.

## 7. Validation and consumer blast radius

Current source checks are the 122-case W1/W2 lane in the linked W2 report, current
typecheck/build/completions, and the conservative source inventory. Their successes
are not receiver/installed/security/UAT passes. The historical full workspace
failure and full Pi timeout remain; complete current full regression is required.

Before an effect is available, an exact executable matrix must cover:

- Native provenance, immutable tools, source-policy, human-question/decision and
  repository custody positives/negatives, including hostile peer instructions.
- Both-endpoint dialog readiness-to-enqueue races, revocation, restart/rebind,
  stale/ambiguous/writer/unknown targets and unsupported host/composition.
- Whole-record UTF-8/line ceilings, both-direction pair concurrency, monotonic
  end-to-end deadline and late response suppression.
- Ack loss, wrong/duplicate/conflicting replies, cancellation/crash/reconnect,
  unresolved new-ID escape and seven-day settled/unsettled retention boundaries.
- Reload/start/disposal twice, truthful lifecycle terminal/unknown states, no
  duplicate callbacks or registry reopening, default-off/standalone/non-Herdr and
  editor/non-Pi regressions. Background/resume feature rollout remains excluded.
- Separate independent exact-candidate security review, hosted CI, installed
  default-entry/pairing, actual authorized writer-A/read-only-B lifecycle/R1/R2,
  NX handoff and all eight genuine Sinh UAT scenarios. Missing lanes are not passes.

Consumers: shared ordinary/selected readers and source-security owners; Pi host,
loader/final-publication/UI and lifecycle owners; registry/capability/decision and
repository custody; both endpoint runtimes; durable recovery/retention; PAPC finite
selection and NX package/wiring/rollback. An upstream/native boundary expansion
needs revised blast-radius review rather than being hidden in a helper change.

## 8. Immediate handback

1. Review the finite-scope implementation and proposed separate Herdr audit-source
   contract with their source/security owners; keep unreviewed source uninstalled.
2. Establish admitted exact Pi/Herdr implementation/API/license evidence, audit
   terminal-input behavior and native receiver/dialog feasibility. No alternate
   reader/copy path after a denial.
3. Revise this draft with real pins/APIs/atomic owners/executable matrix and exact
   tolerances; only then request one review of the new material contract.

No public request tool, runnable messaging command, new capability/config key,
transport endpoint, native approval or readiness is invented by this draft.
