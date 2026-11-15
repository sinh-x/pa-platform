# PAP-299 implementation checkpoint

> Historical d-61f2e6 checkpoint at 8820155. See
> [d-f0ea21 native-owner continuation](PAP-299-native-owner-progress.md) for later
> committed real TicketStore/Git/shared-lock integration, current selection and
> current failures/gates. See also the later
> [reader-worker continuation](PAP-299-reader-worker-progress.md) for the real
> external derivation deadline and read-only complete-delivery verification, and
> [native advanced-lineage continuation](PAP-299-native-reuse-progress.md) for
> real Git/TicketStore reuse with original-source/completion proof.
> Historical check outcomes below are not overwritten.

**Partial implementation — not all phases delivered or accepted.**
Branch: `feature/PAP-299-requirements-handoff-reader`.
Original base preserved: `469e0bf6b12cadd79ddc06a3e050a13760a88e0c`.
No push, merge, installation, resource acquisition/return, live branch handoff,
publication, queue, browser launch or product acceptance was performed.

The operator clarified to continue implementation phase by phase, with source
review later. The new authority/effect cores remain inactive; that clarification
is not a native finite-effect grant or independent review result. No independent
reviewer was spawned. Earlier review-route discussion is not an acceptance gate
passed by this implementer.

## Commits and actual phase disposition

| Milestone | Commit | Delivered | Still missing |
| --- | --- | --- | --- |
| P1 groundwork | `c8aed5e` | Controlling-input/owner inventory, security design, strict new-subject/intent/request parsers and canonical hashes; old package/scopes unchanged | Independent review of actual native selection, consumers, locks, ref durability and launcher |
| P2 core | `6f7cba3` | Inactive finite ref/link transaction engine; real SQLite journal; original-operation recovery, binding checks, revocation/CAS/drift protection | Native association, planned-intent and stage/ref writers; native decision/publication consumer; actual shared lock composition; production Git correlation and ticket-link adapter |
| P3 core | `b9d9df8` | Complete semantic offline reader, deterministic raw/fallback/manifest inventory, private no-replace file publication/readback; bound-opening journal/recovery core | Native tool/profile wiring; fixed trusted browser launcher/display/network/cleanup owner; worker-enforced hard deadline; actual browser/accessibility/maximum accepted fixture observations |
| P4 source | `f0229e4` | Fresh selected policy primer consumes actual selected completion body/hash; policy ordinary-tool contradiction corrected; retained/OPA/workflow negatives | Renewed complete PAPC current and historical validation lanes and installed source-pair qualification |
| P5 checks | This checkpoint | Source results below; conservative inventory reconciliation | Full workspace test completion, complete paired lanes, independent security/code review and hosted CI |
| P6 qualification | Not performed | None | Exact installed/default entry, real foreground prompt/effect counts, browser/accessibility, TS1–18 human UAT and explicit adoption |

P1/P2/P3 commit names denote **core milestones**, not completion of their full
requirements phases. The new contracts/branch/reader/opening modules are not
exported by core's public entry, registered as native tools, selected as new
capabilities, or invoked by retained `pa_document`.
The only currently connected behavior change is the P4 primer projection for a
fresh selected `pa-document-policy/v1` document start. Existing native branch
inspection stays observational; old document scopes gain no Git authority.

## Requirements coverage and remaining implementation

- FR-1–5: **not delivered end-to-end**. Strict intent records do not create caller
  association, planned links or lifecycle/assignment/ref effects. Actual finite
  TicketStore/session/registry integration is still required; keep PAP-292/PAP-296
  retained owners and history unchanged.
- FR-6–7: reader derivation/publication core is implemented and source-tested,
  including all ordered required text/images, nested navigation, unique anchors,
  raw/per-member fallbacks, full searchable/printable markup, identity/output
  digests, immutable generation-state truth, hostile syntax and output-limit
  rejection. It is not connected to a selected native presentation request yet.
- FR-8: actual full selected PAPC completion is now consumed by the fresh policy
  primer, with no fallback from an explicit missing retained resolver. Full
  selected process/aid/objective/dispatch/completion bodies and retained negatives
  are tested. Capability registry and registered producer bytes are unchanged.
- FR-9: durable bound-opening **core only**; no actual trusted browser program is
  selected or launched. Opening results never assert viewing or approval.
- FR-10–14: separate finite subject and original-operation engine exist, but the
  genuine new-subject native review, issued decision consumer, original native
  intent/provenance writer, shared lock hierarchy, durable Git/ref correlation and
  exact ticket owner are not implemented. Fixture ports are NOT those owners.
- FR-15–16: new core result projections separate branch/checkout/queue/launch/UAT;
  no new public native/CLI result path is enabled. Complete current/retained
  qualification and live owner audit remain outstanding. The parent weekly audit
  read in P1 is historical (2026-11-13), not freshly reobserved or repaired here.

NFR limitations remain explicit: no hostile-same-UID/cross-store atomicity claim;
actual process-kill/competing-native-owner/power-loss qualification is unperformed;
source accessibility markup is not browser observation; a post-render elapsed-time
check is not a worker-enforced deadline. Existing image admission is reused, not
claimed as a new complete image-decoder/decompression qualification.

## Actual source checks

| Command / scope | Result |
| --- | --- |
| `corepack pnpm typecheck` | Exit 0, whole workspace |
| `corepack pnpm build` | Exit 0, whole workspace |
| `corepack pnpm completions` | Exit 0; generated tracked completion bytes unchanged |
| Core contract/branch suites | 16/16 passed, zero skips |
| Reader/opening + retained presentation/confirmation suites | 36/36 passed, zero skips |
| Primer/full-body/retained composition suites | 69/69 passed, zero skips |
| Pi `document-*.test.ts`, tool parity and mode-capability session suites | 44/44 passed, zero skips |
| `corepack pnpm --filter @pa-platform/runtime-host test` | Exit 0, 1/1 passed |
| First `corepack pnpm test` | Exit 1: root script tests 42/42 passed; core 2,009 passed / 1 failed / 14 skipped; later packages did not run |
| Full workspace rerun | Timed out after 600 seconds, NOT passed. Before timeout: root scripts 42/42; core 2,011 passed / 0 failed / 14 skipped; OpenCode 106 passed / 0 failed / 1 skipped; Pi script tests 11/11. Pi code suite incomplete; runtime-host separately checked above |
| Staged `corepack pnpm secrets:scan` | Exit 0 before each implementation commit; final checkpoint scan required before its commit |
| `git diff --check` | Exit 0 |

The 14 core/1 OpenCode optional skips are recorded as skips, not acceptance passes.
No failed/timed-out run is replaced by an aggregate passing claim. The full rerun
left no matching `tsx --test`, `pnpm test` or `node --test` process on inspection.

### Preserved failures and bounded repairs

1. P1 fixture preservation assertion compared normalized tickets with absent
   timestamps, so repeated reads supplied different current timestamps. Replaced
   it with exact raw ticket-file comparison; production normalizer unchanged.
2. First reader assertion omitted the generated `rel="noreferrer"` attribute;
   corrected the assertion to require the actual safe complete link.
3. Completed reader output deletion must fail, not auto-rebuild. Added a separate
   immutable publication result and exact completed-inventory verification;
   private original pending-prefix recovery remains separately tested.
4. First new primer test imported the parser from the wrong module. Corrected it
   to `yaml-parser.ts`; no parser/validation bypass.
5. First whole-workspace run correctly detected the changed primer's conservative
   source-inventory hash. Inspected the changed composer and its calls: it reads
   selected instruction text only; no CLI forwarding, new alias, operation dispatch,
   execution grant or effect variant is introduced. Renewed **only** that source
   digest and added a negative catalogue test proving inactive handoff cores are
   not advertised as native operations. No catalogue binding/disposition or source
   guard was relaxed. Core then passed in the preserved timed-out rerun.

## Human-facing wording / message-standard evidence

Affected paths: generated reader metadata/navigation/status; policy deployment
instructions; selected-completion composition blocker. No existing machine JSON,
CLI exit/stream or native decision contracts were changed by wording.

Before: separate companions, `observation=not-performed`; blanket “no shell,
generic source/Git writers” also appeared in explicitly ordinary-tool-selected
policy primers. After: full reader core with “UNAPPROVED-at-generation” and
explicit non-viewing/non-approval limits; policy wording permits ordinary tools
**only when explicitly selected**, still forbids repository/Git/resource writes
and shell/generic writers for logging/registry bookkeeping.

The new unavailable-completion diagnostic has exactly one Condition/Source/Reason/
Correction/Resume Action envelope, <=2,000 JavaScript characters, and one owner
request with impact/actor/approval/prerequisite facts. No raw exception/body/path
is copied into it. It recommends resource-owner reconciliation, not retries,
reapproval, allocation or retained-session upgrades. Source structural/negative
checks passed. Independent human readability, full installed CLI propagation,
keyboard/mobile/zoom/print/image observations and human UAT were not performed.

## Local original evidence

These are local ephemeral logs, not signed or permanent native evidence:

| Path | SHA-256 |
| --- | --- |
| `/tmp/pap299-typecheck.log` | `57cd6e7d1a0554acb197170deef21d5cc7a3c5ad5ac314e1b605ec68542f1a7d` |
| `/tmp/pap299-build.log` | `51e1bce0f373b3f7067a4484a51272b16325386bbf9964dad09a0c4057d9d509` |
| `/tmp/pap299-workspace-test.log` | `560c9f935ad347a453ddc3cd2ca04f0e596ed0e675de79163cda2370e325656e` |
| `/tmp/pap299-workspace-test-rerun.log` | `716ef4bed03d960a4bc3841fd2833a510f40091e8caf5cafb54ddfcbefb995cc` |
| `/tmp/pap299-pi-focused.log` | `1ebf279a084c55d5c2bafac263e2e9e12a0324daeb55162daca5774ca21ef3da` |
| `/tmp/pap299-completions.log` | `3884122d81557448ac4f127de093c860918e3bb65b9c0aa1959d7c75b993d201` |
| `/tmp/pap299-runtime-host-test.log` | `b8c304541c6d492d7add598fdfec677aa5b75cdcb048cd834a1d86c0a7ef572e` |

## Next implementation action

Finish the native P2 owner integration and new-subject review/publication consumer,
then connect P3 to its exact selected profile and trusted launcher. Do not enable
new branch/browser effects merely because these cores compile or fixtures pass.
Resolve/review actual lock/correlation/launcher details and test actual owners,
not only embedding fixtures. Renew complete source/PAPC lanes and independent
review/CI before installed/foreground/browser/TS1–18 human qualification.
PAP-299 status/assignee/primary refs and original branch linkage were not changed.
