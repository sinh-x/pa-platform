# Canonical templates — PAP-270

**Runtime source implementation; not production readiness or ticket acceptance.**
Pi/PPA only. The separate config companion, approved pin integration, actual installed qualification, independent review and human UAT remain delivery gates. No config edits, installation, activation, live product launch, real decision or signed-history rewrite is performed here.

## Public interface

```sh
ppa template list --format json
ppa template show ID --version REVISION --format markdown
ppa template render ID --version REVISION --format json
ppa template validate ID --version REVISION --format json
```

Use exactly the ID/revision reported by the selected registry. There is no `latest`, path/URL lookup, save operation or output target. Render stdin is `{ "bindings": { ... } }`; validate stdin is `{ "bindings": { ... }, "candidate": "exact complete text" }`.

The native `pa_template` takes **one raw JSON request document**:

```json
{"request":"{\"action\":\"list\"}"}
```

Inside that document:

- `list`: `action` only.
- `show`: `action`, `id`, `version`.
- `render`: those fields plus `bindings`.
- `validate`: those fields plus `bindings`, `candidate`.

The operator explicitly selected this unreleased native framing in the continuation of d-5e84fa. Pi supplies already-parsed tool framing, so ordinary object parameters cannot preserve duplicate keys or original request-document byte lengths. The raw document preserves them for the same bounded core parser used by the CLI. No structured-input fallback exists. This is a transport change, not approval/installation authority.

All semantic envelopes are `pa-template-result/v1`, `unsigned: true`. Native rejection uses `isError`; CLI rejection exits 1 with bounded JSON diagnostics. Markdown includes provenance, limitations and the exact source/candidate. JSON transport escaping does not change decoded candidate bytes. **Structural/consumer success authenticates neither people nor referenced evidence, native facts, readiness, custody, publication or executed UAT.**

Validation recomputes the entire deterministic candidate and compares it exactly. It is not a prefix checker, a signed-history migration or a general validator for independently edited final documents. A separately authorized writer/reviewer still owns publication and any permitted administrative changes after a real decision.

## Selected registry and ownership

Config owns `contracts/templates-v1.json` and canonical content under `skills/templates/`. Runtime owns executable schemas, loading, typed rendering and validators, not copies of canonical prose.

Registry fields are exactly `schemaVersion: pa-template-registry/v1`, `runtimeContract: pa-template-runtime/v1`, `configRevision`, `entries`. `configRevision: "selected"` explicitly binds the externally authenticated runtime pin: a committed manifest cannot contain its own commit hash. An explicit full lowercase SHA is also supported only when it matches that pin. Response provenance always reports the actual selected revision, never the selector token.

Each entry contains:

- `id`, immutable numeric/`rNNN` `revision`, `purpose`, `owner`.
- `contexts`: `{runtime:"pi",team,mode}` rows; `*` is explicitly unrestricted. Retrieval reports context; rendering checks actual host team/mode, never request-supplied identity.
- `source`: `{path,sha256,selector}`. Path is a contained canonical-family Markdown file; SHA-256 covers the **entire raw file**. `selector` is null or one unique ordered `{start,end}` delimiter pair. Show preserves the entire file; rendering uses exactly the selected intervening bytes.
- `bindings`: named `{type,required}` contracts. Types are `text`, `multiline`, `ticket`, `repository`, `root`, `path`, `branch`, `sha`, `digest`, `revision`, `handoff`, `matrix-source`, `comment-ref`, `json`.
- `validation`: `{kind,sections}`. Document headings are config-owned; runtime enforces profile minimums and typed structures. Critical producers must declare their actual consumer kind, not generic headings.
- `capabilities`: `{render,validate,reason,authorityGate}`. A disabled capability is explicit, not a silently omitted standard or authority claim. Validation cannot bypass a disabled renderer.

Runtime metadata adds the exact `templateSchema`. The initial inventory is authoritative and closed:

| IDs | Structural contract |
|---|---|
| `requirements` | At least 16 numbered sections, one supported class/route, typed metadata, FR/NFR/AC traces and the actual raw matrix-plan parser/source/digest/tuple agreement. |
| `uat-review` | Review sections, required metadata, concrete unexecuted scenarios; no manufactured UAT result/sign-off. |
| `builder-objective` | Direct-phase objective, scope/check sections and metadata; `Execution Model: direct-phase`, never retired implementation-child dispatch. |
| `implementation-phase-report` | Eight populated sections and complete checks table; facts remain unverified until their actual owner supplies evidence. |
| `orchestration-report` | Populated living-report sections and canonical context metadata; no custody/finalization claim. |
| `project-agent-guide` | Nine numbered sections and repository/version metadata; no source-write authority. |
| `spike-full-requirements` | Thirteen numbered sections and draft/context metadata. |
| `spike-learning-note` | Populated research sections plus bounded, duplicate-free, alias/tag-free CORE-schema frontmatter and draft/pending source metadata. |
| `spike-light-report`, `spike-research-report` | Complete populated section contracts and applicable metadata/evidence limitations. |
| `uat-plan` | Distinct plan contract: each declared AC has exactly one concrete TS with preconditions, steps and expectations; actual results/status remain not run. |
| `handoff-fresh`, `handoff-amendment` | Actual shared `pa-task-handoff/v1` tuple parser. |
| `pair-signoff` | Actual shared finite `pa-pair-signoff/v1` parser and resolver round trip. |
| `review-matrix`, `review-objective` | Actual protected-review v1 consumers, not parallel formatters. |

The first ten IDs retain their canonical filenames. Additional canonical-family files require explicit runtime inventory/version support; directory enumeration is only a closure check. Missing, undeclared, nonregular or aliased resources reject the whole selection. The optional explicitly inventoried PAP-271 extension is `review-bundle`; it does not create another registry.

The currently selected config's `builder-objective.md` is a **retired implementation-child template**. It was not copied, revived or aliased here. The companion must deliberately supply an appropriate direct-phase producer or obtain an explicit disposition; a retired source cannot pass the mandatory active-producer qualification by changing a capability flag.

## Determinism, bounds and provenance

`{{name}}` substitutes one declared typed binding. `{{#optionalName}}...{{/optionalName}}` selects a present optional value; `{{^optionalName}}...{{/optionalName}}` selects its absence. These are bounded, non-nested declarative selectors, not expressions, loops, imports, shell expansion or evaluation. Unknown tokens in inactive branches also reject. Bound JSON is encoded once with stable key ordering; embedded literal braces are data, never recursively interpreted. Multiline narrative is indented and preserves CRLF, so it cannot supply metadata/headings. Signed/raw source bytes are never reformatted.

Missing/unknown/unused/unresolved/duplicate/wrong-type bindings reject. Declared binding diagnostics identify the schema-owned field without echoing rejected values or unknown keys. Identifiers/tuples reject controls/format injection. Document headings cannot be supplied from fenced/indented examples; required sections must be ordered, unique and populated. Learning-note YAML cannot instantiate runtime values or expand aliases.

Limits: request documents 65,536 UTF-8 bytes; registry/source/candidate 1,048,576 bytes each; nesting 64. Complete envelopes share a 50-KiB transport cap; oversized results fail on both interfaces, never truncate authority-bearing bytes. BOM, malformed UTF-8/unpaired surrogates, unsafe aliases, oversized/nonregular/changed sources and conflicting shared-source identities reject. Diagnostics have five named fields, stay below 2,000 characters and disclose no body/token/raw OS exception.

Runtime pins are `.pa-platform-config.sha` and `.pa-template-registry.sha`. The registry pin is deliberately absent until separate companion delivery and authorized integration. It is **content compatibility, not a workflow enablement toggle**. Nix packaging copies these pins when available; immutable Nix metadata may legitimately be store-deduplicated, but template resources cannot use that exception.

The existing selected home/teams resolver must agree physically. Default selection observes exact loose/packed/detached/linked-worktree Git HEAD without a subprocess, validates worktree back-pointers and checks the runtime pin. Raw resources are content-addressed, read without following aliases and rechecked as one stable source set with nanosecond fingerprints. Relevant dirty substitutions, inventory additions, root/revision changes and read races fail closed. No alternate checkout, `PA_CONFIG`, newest-file or bundled-prose fallback exists. Qualification additionally proves a clean committed selection and ancestry of cached `origin/develop`; it never queries a live remote or supplies merge authority. Actual merge provenance/freshness remains with the release/review owner. An envelope is not a whole-checkout clean/merged attestation.

Producer receipts are `pa-template-producer/v1`: template ID/revision/schema, raw source digest, config revision, registry digest, canonical typed-binding digest, exact candidate digest and consumer contract. Receipts are **untrusted provenance data, not importable permission**.

## Typed handoff/sign-off consumers

`workflowProducerBindings()` exposes the required runtime-owned schemas. Config cannot downgrade a tuple/hash into free narrative.

Fresh handoff binds ticket, repository key/root, exact branch/full base, `planned/create`, route and draft status. Amendment binds the retained branch/base/full feature SHA, `materialized/select`, existing requirements source, own-ticket tuple-approval reference and immediate/final reread evidence digests. Those digests/references are structural inputs, not authenticated reread facts. Fresh-only and amendment-only fields cannot be mixed. The actual resolver retains its independent status, primary-source, author, own-ticket, withdrawal, branch/base and Git/custody checks.

`PA pair-signoff/v1` is an exact finite multiline candidate: decision kind, full tuple, source/revision, canonical requirements/UAT preview locators and raw hashes, matrix source/digest, plus complete amendment fields when applicable. Unknown/duplicate/conditional/negated extra clauses fail. The existing resolver uses the **same parser**, then authenticates its selected own-ticket human comment and raw previews, UAT source/revision, complete matrix and actual tuple before dependent effects. Published new-v1 requirements must preserve reviewed bytes except the explicitly permitted administrative preamble fields (`Status`, review/matrix approval evidence, review progress, shape-conformance). Neither body/scope nor signed digests are silently normalized or repaired.

Existing standard/owner-directed, WAW, TTL and compact legacy producers remain under their original contracts. The bounded retained NX family additionally validates its complete locator, revision, tuple, link, matrix clause, exact plan restatement and safety boundary, plus source-bound UAT evidence. No opening-prefix-only or arbitrary approval-keyword inference was introduced. Historical signed artifacts are untouched.

This compatibility route is **not PAP-271's new authority route**. A draft, parser result, supplied author, receipt or template call cannot issue a structured decision or become a real Sinh comment. PAP-271 must keep its typed decision/capture/revocation owner and never fall back to legacy text for new-route authority.

## PAP-271 / d-2b2949 integration

Use the SAME selected registry and shared service, not a copied bundle formatter:

```ts
const draft = templateService({
  action: "render", id: "review-bundle", version,
  bindings: { bundle: exactSubject },
}, {
  selection, team, mode, // runtime-owned, never tool JSON
  reviewBundleConsumer: {
    schemaVersion: "pa-review-bundle/v1",
    validate: parseReviewBundle, // PAP-271's actual parser
  },
});
```

The companion's optional `review-bundle` entry uses `validation.kind: review-bundle`, typed JSON bindings and canonical selected content. Missing actual consumer gives `TEMPLATE_CONSUMER_REQUIRED`; tool requests cannot register callbacks or host identity. The CLI dispatcher and native module factory accept this trusted-host seam. PAP-271 owns default-host registration, exact subject retention, artifact/evidence authentication, real principal/decision capture, issuance/revocation, progression and existing effect owners. Rendering activates none of them. PAPC remains the sole workflow enablement owner.

A disposable read-only cross-source probe imported PAP-271 `cd73ff7`'s ACTUAL `parseReviewBundle` and synthetic fixture: fresh/amendment each passed 20 deterministic renders, exact validation and eight invalid-subject cases. This is parser compatibility evidence, not owner integration, installation, decision capture or authenticated continuation. The sibling worktree was not modified. Portable fixtures separately prove delegation without pretending a spy is the actual workflow consumer.

## Qualification contract for the separate companion

```sh
node scripts/dev/verify_template_contracts.mjs --mode paired-config
node scripts/dev/verify_template_contracts.mjs --mode selected-installed --binary ppa
```

Besides the registry/resources, config supplies:

- `contracts/templates-fixtures-v1.json`: `schemaVersion: pa-template-fixtures/v1`, `fixtures`, exactly one `{id,version,bindings,candidateSha256,context:{team,mode}}` per selected entry.
- `contracts/templates-adoption-v1.json`: `schemaVersion: pa-template-adoption/v1`, raw `registrySha256`, `consumers:[{team,mode,templates:[ID,...]}]`. Include requirements/analyze, builder/orchestrator and requirements/review-auto; extra relevant modes are allowed. Every entry must have an explicit adopted producer context and coverage.
- Actual selected team YAML/instruction/skill resources. The driver follows those declarations, not guessed instruction filenames or filesystem search. It verifies their exact committed bytes and generated-primer template references/contexts. This is reference consistency, not a replacement for companion policy-behavior tests or existing safety gates.

The driver requires clean exact selected HEAD and cached `origin/develop` ancestry, checks every consumed blob against that commit, tests all four CLI/registered-native operations with 20 repeats per entry and required negative cases, then rereads resources/HEAD/status. Git reads disable hooks/fsmonitor, index writes, pagers, replacement objects, lazy fetch and protocols; no config-provided code or product is launched. Missing/disabled producers or cases block, not skip-and-pass.

Installed mode additionally authenticates the actually resolved immutable Nix binary, package/source/config/registry provenance and **exact compiled module bytes**, then invokes that public binary and its native module. It reports actual module/binary digests, not just a version label. It never installs, selects a different package or grants readiness. Source-built, disposable-pair, installed, independent-review, CI and human-UAT evidence remain separate.

## Phase commits and observed evidence

- `6cf3dab`: registry/loader; `a46ce89`: service/CLI/Pi; `44073b7`: review consumers/PAP-271 seam; `f6e65a3`: initial qualification checkpoint.
- `1c54e16`: actual typed handoff/pair consumers and bounded NX compatibility.
- `8dfb3ea`: complete standard profiles, stable provenance, raw native documents, actual built PPA entrypoint coverage and version-dispatch correction.
- Qualification/guidance continuation: generated-adoption proof, full positive/negative driver fixture, immutable module identity and shared discovery text. No source/config pin is fabricated to make qualification pass.

Observed source checks: workspace typecheck/build passed; focused template/retained-review/baseline suites 375 passed, zero failures/skips; Pi template/public-entry/composition suites 15 passed, zero failures/skips; qualification argument fixtures four passed. Actual public PPA fixture covers all sixteen producers and 20 renders each with unchanged filesystem snapshots. A committed disposable config qualifies through the real paired driver (1,280 operation comparisons plus required negatives), including a hostile Git-fsmonitor non-execution check and changed-instruction rejection. These are synthetic/source-built observations, not selected installed readiness or human decisions.

An earlier full workspace development run found one frozen historical loadout assertion (the new tool was intentionally absent from that historical fixture). It was corrected without rewriting historical fixture bytes and its focused rerun passed. A final full-workspace rerun is recorded separately; do not infer it from the focused counts. The approved independent matrix retains its original timeouts: the observed long development run is not an authorized timeout extension or a passing independent matrix.

## External completion gates

1. Separately scope/deliver the config companion: canonical active content/extractions, retired-objective disposition, registry/adoption/fixtures and instruction changes, contract/ownership manifests and companion tests. No companion ticket or cross-repository edit is authorized implicitly here.
2. Obtain the approved clean merged config revision and integrate exact runtime pins through the authorized config-first flow. Current missing pair is blocked, not passing. No new workflow controller, activation flag or terminal-ticket dependency cycle is introduced.
3. Perform authorized exact candidate packaging/selection and actual installed disposable qualification, including PAP-271 host integration where that extension is selected. No installation, Nix rollout, external service, PR/merge or checkout return is implied.
4. Complete the independently admitted exact eleven-command matrix, reconcile its prerequisite/time budgets without silently modifying approval, obtain CI and execute all ten human UAT scenarios. Required-case gaps remain failures/blockers; source tests cannot supply human acceptance.

Keep the ticket incomplete until those delivery/acceptance gates are proven. The source interface is available to the companion and PAP-271 now; it does not require either ticket to become terminal first.
