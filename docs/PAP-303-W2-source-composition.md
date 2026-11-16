# PAP-303 W2 — source/composition reconciliation

> **Finite-scope decision — 2026-11-16:** Sinh selected “Restore finite
> selected-source scope.” Ordinary admission now requires one link, with no
> immutable-store exception; the private selected-Pi route remains finite.
> Herdr audit-source access still needs its own reviewed contract. The broader
> candidate described in §§2–3 is historical and has been withdrawn, not installed.
> This source-scope direction is not independent review or full P1 acceptance.

Date: 2026-11-16. Deployment `d-b59414`; same explicit single-writer continuation.
Ticket worktree `/home/sinh/.treehouse/pa-platform-cdb114/15/pa-platform`, retained
HEAD `66629b6d2afdc44e3f9c346440f40791c3a9aeb5`. W1 edits and the prior handoff
are retained. No installation, host/default selection, external configuration,
new deployment, peer message, native registry rebind or branch change is selected.

**Source analysis, not independent security approval or installed qualification.**
W2 characterizes the source candidate and keeps unresolved policy/API evidence
explicit. [W1](PAP-303-W1-helper-hardening.md) remains a separate source checkpoint.

## 1. Actual source composition and evidence boundaries

- `packages/pi-pa/src/adapter.ts` builds managed foreground/process arguments with
  `--no-skills --no-extensions`, the planned skills and trusted `--extension`.
  `buildPiBackgroundArgs` uses the corresponding managed branch. This is source
  behavior, not a fresh observation of a complete installed process argv.
- `pi-extension/index.ts` registers the fixed PA module composition, including
  guarded read/bash and the result hook. The default-off Herdr lifecycle module
  adds advisory socket writes only under its explicit environment/socket binding.
  There is no peer request/response tool registered by the W1 helpers.
- Ordinary `createSecureLocalReadTool` fixes the native acquirer; tool JSON cannot
  choose it. Registration wraps direct executions with existing admission,
  safety, local-result filtering and cancellation/shutdown lifetime checks.
  `tool_result` adds a separate content-filtering hook. Path admission and content
  projection are different obligations: a later content filter cannot prove a
  foreign reader admitted the original path or scanned the complete file.
- The build-selected, separately default-off `selected-pi-host.mjs` admits exactly
  one trusted extension spelling and one `--no-extensions`, invokes an inline
  factory, and composes its own host-derived selected-document acquirer with
  `ReadPublicationOwner`. Its native publication hook is the intended stronger
  boundary; ordinary external Pi does not gain that hook from a marker or an
  `agent_end` warning. PAP-298's known remaining production/installed gaps remain.
- The selected host still drops all four Herdr opt-in/binding variables because
  they are absent from its finite environment list. W2 does not widen that list;
  forwarding names alone would not authenticate a pane, role or incarnation.

Standalone AgentKit interference observed in earlier sessions is not proof that
managed trusted-only composition loads that plugin. No external hook/configuration
was changed, and no register-last workaround is treated as a universal boundary.

Normal installed Pi README/extensions-document reads were denied in this
continuation's earlier checks. Those failures are retained, not retried via a
shell, package copy, alternate source locator or loader introspection. Exact
installed Pi1.4.0 hook/API/license evidence remains unavailable here. Any inert
project-dependency runner test establishes only its labelled test seam, not the
installed package or current live hooks.

## 2. Shared immutable-store candidate at W2 entry (historical)

At W2 entry, ordinary `acquireLocalSourceFile` permitted a multi-link
file by exact `/nix/store` spelling when descriptor-owned facts establish root
ownership, reviewed write-bit/sticky-store rules, stable ancestry/file identity,
regular bounded complete text and UTF-8/control/media restrictions. Protected
logical/resolved paths and complete-file content projection still apply. Strict
artifact/manifest adoption has not been relaxed.

**This is nevertheless a general ordinary-reader admission widening.** It covers
other immutable packages and standalone `.ts` store objects, not merely one
executing Pi's README/docs/examples. The ordinary route supplies no selected-host
binding. A separate selected-document constructor still checks the finite scope
and live producer, but its existence does not make the ordinary store route
selected-only. Immutability/world readability prove neither authorization nor
selection/provenance. Existing documentation saying selected Pi documents always
need a binding is therefore misleading unless it specifically means that route.

PAP-298 production requirements explicitly retain ordinary single-link behavior
and prohibit a general Nix exception. PAP-303's lifecycle/API audit does not itself
approve a change to that owner boundary. The initial W2 analysis left that choice
open; Sinh's subsequent finite-scope decision above restored the narrower boundary.

### Considered alternatives — finite scope subsequently selected

| Alternative | Benefit | Remaining obligation |
|---|---|---|
| Restore ordinary single-link admission; use the existing authenticated selected-Pi route and a separately reviewed finite Herdr audit-source contract | Preserves PAP-298's finite provenance scope and limits the policy change | Herdr source acquisition still needs its own admitted exact contract; no shell/copy fallback. Installed access remains blocked until real supported rollout. |
| Retain exact immutable-store ordinary text as an explicit new policy candidate | Simpler general read mechanics and addresses multi-link metadata rejection for more packages | Explicit material scope decision and independent shared-security review are required. Review logical/resolved confidentiality rules, Nix trust assumptions, hard-link/alias/media/race boundaries, actual final publication and compatibility with PAP-298. No installation/default activation follows from this source analysis. |

Sinh subsequently selected the first alternative in the foreground question.
The ordinary broad route and its policy helper were removed; no Git reset was
used. The private finite selected-Pi route and all path/content/artifact guards
remain. This resolves the source-scope conflict by narrowing admission, not by
approving a general store exception. Herdr's separate audit-source contract and
independent review remain open. Inventory hashes track the resulting candidate;
they grant no permission, installed proof or final P1 acceptance.

## 3. Semantic reconciliation of all inventory mismatches

An enumeration of **all 159 existing entries** found exactly these four mismatches
at W2 entry, rather than only the first failure reported by the test:

| Source | Changed behavior / effect / existing owner |
|---|---|
| `pa-core/src/source-content-security.ts` | Unsupported-file wording describes new supported shapes. The earlier generic correction also offered an alternate spelling; W2 removes that shortcut and keeps source/runtime owner inspection. No new error code, machine field, exit mapping, CLI form or permission. |
| `pa-core/src/local-source-file.ts` | At entry, real ordinary-store admission widening (§2), not merely wording. After Sinh's finite-scope choice it was removed: ordinary ingress requires one link; only the private selected-Pi route considers qualified multi-link text. Descriptor/content/selected/artifact owners remain separate. |
| `pi-pa/src/pi-extension/bound-local-read.ts` | Adds a result-details marker after guarded success or typed denial. Marker presence changes observations, not source eligibility, role admission or publication custody. |
| `pi-pa/src/pi-extension/index.ts` | Adds end-of-turn activity reporting and the default-off Herdr lifecycle registration. The latter introduces conditional advisory socket/session-state effects, not peer input or new CLI/native forms. Existing launch/composition/lifetime owners retain authority. |

Paths in this table are under `packages/`. The source-owned interaction catalogue
lists CLI/selected-native operations, not every private lifecycle callback.
Existing launch/resource ownership still covers composition; there is no invented
public `pa_peer_request`, lifecycle capability or installed native binding.

The reconciled conservative guard renews those four reviewed source entries and
adds `pi-extension/source-guard-coverage.ts`, `pi-extension/herdr-lifecycle.ts`,
`pi-extension/herdr-peer-admission.ts` and `pi-extension/herdr-peer-exchange.ts`.
It now covers **163 entries**. The W1 helpers are tracked private dependencies,
not registered dispatch/effects. A regression forbids advertising a peer command
or native operation merely from that inclusion. The inventory remains change
detection, not policy approval, semantic coverage proof or independent review.
Future helper wiring requires new reconciliation.

## 4. Marker and final-delivery boundary

`pa-local-read/v1` is a public details string. A foreign extension or copied result
can reproduce it. Even a private object mark would need the actual consuming
runtime's ownership/lifetime contract; a string cannot become that boundary.

Legacy `guarded`/`unguarded` counters mean **marker-labelled/unlabelled results**,
not authenticated guard coverage. An absent marker does not prove which reader
ran, and a present marker does not establish source admission, complete scanning,
publication integrity or cancellation safety. The event remains a bounded
informational observation, emitted only when an unlabelled read is seen; silence
is not an enforcement pass. Audit schema/count fields remain unchanged.

The selected publication owner associates pending owned reads with content
identity and withholds an unowned replacement, including one bearing a forged
marker. It is not a hostile same-process-plugin sandbox. Unknown/unreviewed
foreign mutation/composition cannot be admitted solely by invoking this owner or
registering a guard last. Its actual selected host, final consumer sink and all
transforms must be qualified under PAP-298; no standalone synthetic callback
proves production binding.

## 5. W2 verification plan and current limits

Use fresh inert files/canaries only; no live Herdr socket or denied installed
content. Characterize:

1. Trusted registered ordinary path admission plus full-file content projection.
2. Project Pi `ExtensionRunner` result-hook ordering with PA first/last and an
   inert foreign replacement; do not generalize this to the unavailable installed
   host or a particular AgentKit plugin.
3. Copied/forged marker observations and selected-publication rejection of unowned
   or replaced result identity. Count observations without claiming authentication.
4. Existing core descriptor/text/selected-scope/artifact tests; guard/result/native
   publication/composition tests; source inventory and discovery tests.

Results before the subsequent finite-scope restoration (historical; restoration
checks are recorded in the follow-up below):

- Initial source/descriptor/selected/text/artifact/local-reader/publication/new
  composition lane: **68 pass / 0 fail / 0 skip**.
- Reconciled interaction inventory/discovery lane: **16 pass / 0 fail / 0 skip**.
- Workspace `corepack pnpm typecheck` and `corepack pnpm build`: **pass**.
- Final combined W1/W2/ordinary-question lane: **122 pass / 0 fail / 0 skip**.
- `corepack pnpm completions` and `git diff --check`: **pass**, no generated
  tracked completion changes.
- An isolated 30-second-budget `pi-question.test.ts` run passed **8/8**. This does
  not establish the cause or resolution of the earlier full Pi timeout.

The hook-order test observed an inert foreign hook restore its canary after the
PA filter when ordered last; PA-last filtered it. That test passes by exposing
this composition limit, not by declaring arbitrary hook combinations safe. The
publication tests refused forged/unowned/replaced identities through the actual
repository publication owner with a test callback, not a production host grant.

Exact combined command, from the ticket worktree:

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 --test-timeout=60000 \
  packages/pa-core/src/__tests__/source-content-security.test.ts \
  packages/pa-core/src/__tests__/local-source-file.test.ts \
  packages/pa-core/src/__tests__/immutable-document-policy.test.ts \
  packages/pa-core/src/artifacts/__tests__/manifest.test.ts \
  packages/pa-core/src/__tests__/interactions-catalogue.test.ts \
  packages/pa-core/src/__tests__/interactions-discovery.test.ts \
  packages/pi-pa/src/__tests__/source-composition-boundary.test.ts \
  packages/pi-pa/src/__tests__/local-source-security.test.ts \
  packages/pi-pa/src/__tests__/read-publication.test.ts \
  packages/pi-pa/src/__tests__/herdr-lifecycle.test.ts \
  packages/pi-pa/src/__tests__/herdr-protocol-conformance.test.ts \
  packages/pi-pa/src/__tests__/herdr-peer-exchange.test.ts \
  packages/pi-pa/src/__tests__/pi-extension-composition.test.ts \
  packages/pi-pa/src/__tests__/pi-phase3.test.ts \
  packages/pi-pa/src/__tests__/pi-question.test.ts
```

Complete workspace regression has not been rerun after reconciliation. The earlier
full-core failure and 900-second Pi timeout remain historical outcomes; the
specific inventory test is now green, not the entire workspace. Exact installed/
foreground source provenance, independent review and human acceptance remain
separately required.

### Finite-scope restoration follow-up

After Sinh's selection, the ordinary store exception and its helper were removed.
No Git reset, alternate source reader, installation or host switch was used.
`acquireLocalSourceFile` again requires one link; the private selected-Pi route
still requires its finite binding/scope, immutable metadata/text and lifetime.
The unsupported-source reason now states those two routes explicitly.

Current restoration checks, all exit 0:

- Workspace `corepack pnpm typecheck`, `corepack pnpm build`, completions and
  `git diff --check`: **pass**.
- The exact 15-file combined command above, rerun after restoration:
  **122 pass / 0 fail / 0 skip**.
- Existing inert Nix mechanics fixture, with one added ordinary-store negative:
  **5 pass / 0 fail / 0 skip**. The new regression confirms actual root ownership,
  read-only mode and multiple links, then observes `LOCAL_SOURCE_UNSUPPORTED_FILE`
  with **zero payload reads** through the ordinary guarded reader. Fixture
  metadata is unchanged; no selected-reader retry follows that denial.

```sh
corepack pnpm --filter @pa-platform/pa-core build
PA_TEST_IMMUTABLE_DOCUMENT_FIXTURE=/nix/store/sk6n993a0jyl6n2sq5w80w96d3cvw2mh-pa-inert-immutable-document-mechanics \
NO_COLOR=1 node --import=tsx --test scripts/dev/selected_document_mechanics.test.mts
```

Those positives use the existing test-only selected binding and freshly authored
inert Nix texts. They prove mechanics, **not** an authenticated installed Pi
producer, permitted access to denied installed docs, or a Herdr-source grant.
No Nix fixture was modified or installed. Source-inventory entries were reconciled
again for the narrowing; 163 entries remain. Full workspace/installed/independent/
CI/human gates and the historical timeout limitations remain unchanged.

### Human-facing message review

Affected existing paths: `SourceContentSecurityError` local read/bash/custom-tool
blockers (the unsupported-source reason plus common correction), and the optional
`source-guard-coverage.ts` informational warning/activity event. No CLI command,
JSON code/field, exit, stream or audit schema was added.

- Unsupported reason before: selected Pi documents additionally require a binding,
  plus common advice to “retry with an admitted source spelling.” After: the
  selected route is explicitly separate, with ordinary single-link admission; correction
  asks the existing security/runtime owner to inspect classification/rules, with
  no alternate-spelling workaround.
- Coverage before: reads “were delivered by a reader outside the PA source guard”
  with a guarded count. After: results “lacked the PA source-guard marker”; markers
  and counts do not authenticate the reader or prove admission/final delivery;
  inspect the existing registered reader/publication owner before claiming that.

Source/code review checked outcome, uncertainty and next action in plain text.
Tests actually check all six fixed blocker codes for one each five labels,
<=2,000 JavaScript characters, no ANSI, no private exception/pattern leakage;
new warning tests check bounded size, truthful marker language and no fixture
path/body disclosure. Direct, registered, nested and real project-runner results
remain covered. Independent human readability, full installed CLI propagation,
exact installed enforcement and genuine UAT were **not run**.

## 6. W3 handoff boundary

The [W3/P1 contract proposal](PAP-303-P1-contract-draft.md) is a feasibility-bounded
unapproved draft. It cannot manufacture missing source/API/authentication or
protected-receiver evidence. Preserve the settled numeric, consent, privacy,
recovery and retention policies. Herdr remains
a lifecycle/discovery substrate, not a proven provenance-safe request/reply
transport. No agent-context reception, human-approval substitute, terminal-input
fallback, new service, install or peer effect is authorized by this document.
