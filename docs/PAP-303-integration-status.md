# PAP-303 — source-checkpoint integration status

## Outcome and scope

Sinh explicitly requested committing the retained PAP-303 changes and merging a
PR into `develop`. This is integration of a **default-off/partial source
checkpoint**, not full PAP-303 acceptance, installation, runtime selection,
permission to send peer messages, or closure of the P1/P4 evidence gates.

Code/test checkpoint: `0a4a470cf110ff63494bdece02a3ac181ae0436f` on
`feature/PAP-303-herdr-trusted-bridge`, following retained HEAD `66629b6` and merged
develop `9489913` (v0.1.170). The PR's final head also carries the documentation
handoff. GitHub PR/check/merge results must be observed separately; this document
does not predeclare them. The normal repository workflow owns any post-merge
patch bump; no manual release/tag, dependency/hash refresh or installation is
selected by this source integration.

## What the final candidate contains

- A trusted Herdr lifecycle bridge, default off, with advisory bounded socket
  reporting. It imports no HOME/project Herdr extension and registers no peer
  request tool. Real installed lifecycle/dialog/disposal behavior remains
  unqualified; its source tests are not proof of that behavior.
- Effect-free request planning and metadata-only target/reply observations.
  Echoed nonce text and completion counters cannot yield a correlated response;
  no terminal reply bodies are returned. Unknown readiness/counters/session facts
  fail closed, and a positive preliminary target observation still explicitly
  leaves send admission unavailable.
- Whole-planned-parameter request bounds, UTF-8-safe observation bounds and
  permanent multibyte/line/state/counter/false-attribution regressions.
- **Finite source scope**, explicitly selected by Sinh after W2 review. Ordinary
  reads require one link; root ownership, read-only mode or a `/nix/store` spelling
  is no exception. Only the private native selected-Pi documentation route may
  consider qualified immutable multi-link text. No Herdr-source exception was
  invented. The earlier general ordinary-store experiment exists in retained
  feature history but is **withdrawn from the final tree**.
- Source-guard marker reporting described accurately as observation, never an
  unforgeable enforcement attestation. Controlled project-runner tests expose
  foreign-hook ordering limits; private publication tests do not claim installed
  producer custody.
- Semantically reconciled conservative source inventory, with 163 tracked source
  hashes and no invented peer command/native capability. Hash renewal is change
  detection, not independent approval.

The source patch preserves native safety/admission, immutable tools, human
question/decision ownership, source/content/artifact protections and repository
custody. No PAPC/NX configuration, installed package, ticket lifecycle or lease is
changed. The existing feature checkout and its history are retained; no reset,
rebase, force-push, branch deletion or worktree return is part of this request.

## Evidence already executed

- Latest combined W1/W2 source/security/descriptor/selected/artifact/inventory/
  discovery/reader/publication/composition/question lane: **122 passed, 0 failed,
  0 skipped** after finite-scope restoration.
- Existing inert immutable Nix mechanics lane: **5/5 passed**. The added ordinary
  negative rejects an exact root-owned/read-only/multi-link store fixture before
  payload access. The positives use a test-only selected binding, not an
  authenticated production host or permission to read denied installed sources.
- Workspace typecheck/build, generated completions and whitespace checks passed
  on the source candidate. A real staged secrets scan passed before the code
  commit. Later candidate/CI results belong to their exact observed heads.

Historical full-workspace attempt: pa-core 2,294 passed / 1 failed / 14 skipped,
with 42 root pretests passed; the inventory mismatch was subsequently repaired
and its focused test passed. The full Pi package attempt timed out at 900s; its
stale 12-vs-13 module fixture was subsequently corrected and focused-tested.
**Neither earlier full run becomes green from those repairs.** A complete current
manual integration run remains outstanding. CI deliberately runs the repository's
existing code-only lane; do not weaken that inventory or relabel its explicit
manual deferrals as passing integration tests.

Human-facing paths/categories touched are the existing typed local-content
blockers and informational coverage event. Before/after examples, actual
bounded/five-label/no-private-output software checks and separate human/installed
limits are in [W2's message review](PAP-303-W2-source-composition.md#human-facing-message-review).
No new public CLI command, machine code/field, exit/stream contract or audit schema
was introduced by those wording corrections.

## Remaining gates — no product completion claim

1. Admitted exact Pi/PPA/Herdr implementation/API/license/privilege evidence,
   authenticated NX package/config pairing and standalone/managed loading proof.
   Original denied installed-source reads remain denied; no alternate read/copy
   fallback was used.
2. Proven protected agent-context submission **and reception/reply**, with one
   atomic consent/native-dialog/read-only-role/live-incarnation boundary. Herdr
   prompt/wait/read, a nonce and pane/CWD mapping do not establish this.
3. Reviewed concrete durable reservation/deduplication/uncertainty/recovery/
   retention and total-deadline owners, exact executable matrix and real timing/
   cleanup tolerances. Settled numeric/privacy policies remain unchanged.
4. Independent exact-contract/code security review, complete current manual
   regression, hosted CI evidence, separately authorized installed/default-entry/
   foreground writer-A/read-only-B lifecycle/R1/R2, NX handoff and genuine Sinh
   UAT. Source integration is not a pass or waiver of any missing lane.

The six-item P1 contract remains incomplete. Lifecycle-only staging cannot pass
full messaging acceptance. Do not mark PAP-303 Done, activate defaults or send a
peer request merely because this checkpoint is committed, reviewed by CI or merged.

## Detailed retained records

- [W1 helper hardening](PAP-303-W1-helper-hardening.md)
- [W2 source/composition and finite-scope decision](PAP-303-W2-source-composition.md)
- [W3/P1 proposal — unapproved, feasibility blocked](PAP-303-P1-contract-draft.md)
- [Lifecycle audit/source notes](PAP-303-herdr-lifecycle.md)
- [Reconciled continuation handoff](../plans/261116-1541-pap303-follow-up/d-b59414-handoff.md)

Earlier notes retain their historical branch/dirty/check coordinates. They are
not current clean-candidate attestations, native approvals or replacement
requirements/UAT publications. The PR and normal post-merge workflow are the
separate source of actual integration/patch-bump outcomes.
