# Canonical templates — PAP-270 source checkpoint

**Partial implementation; not production-ready or ticket acceptance.** Pi/PPA only. No config repository edits, runtime installation, workflow activation, real decisions, signed-artifact rewrites or product launches are performed by this feature.

## Phase commits

1. `6cf3dab`: strict registry/binding metadata, explicit initial inventory, bounded content-addressed selected loader and disposable fixtures.
2. `a46ce89`: shared render/validate service, `ppa template`, registered `pa_template`, PPA-only completions and adapter parity fixtures.
3. `44073b7`: **partial Phase 3**: actual protected-review matrix/objective consumer round trips, producer provenance receipt and PAP-271 bundle extension/consumer port. Historical resolver grammar is unchanged. Full legacy handoff/sign-off production, including NX-066 compatibility, is **not delivered**.
4. Qualification/documentation checkpoint: fixed-path paired/installed driver, packaging for compatibility pins, additional no-effect/CRLF fixtures and continuation contract below. Missing pairing remains a failure, not a skipped pass.

## Public interfaces

```
ppa template list --format json
ppa template show ID --version REVISION --format markdown
ppa template render ID --version REVISION --format json
ppa template validate ID --version REVISION --format json
```

Render reads exactly `{ "bindings": { ... } }` from stdin. Validate reads `{ "bindings": { ... }, "candidate": "exact complete candidate" }`. No file, URL, output target, version alias or save operation exists. `pa_template` has the same four operations and semantic envelopes, with native errors marked `isError`. CLI rejection exits 1 and emits the same bounded JSON diagnostic envelope. Markdown includes provenance, limitations and the exact source/candidate payload; use JSON for byte comparisons.

Every result is `pa-template-result/v1`, `unsigned: true`. A successful structural check is not a decision, native report attestation, readiness, custody, publication or executed UAT. Validation recomputes the entire deterministic candidate and compares it exactly; it does not accept an opening prefix or normalize an independently edited document.

## Selected content contract for the separate config companion

No canonical prose is copied into runtime. Config supplies `contracts/templates-v1.json`, conforming to the executable schema in `packages/pa-core/src/templates/schema.ts`:

- Exact `schemaVersion: pa-template-registry/v1`, `runtimeContract: pa-template-runtime/v1`, `configRevision` (full lowercase Git SHA), and `entries`.
- Every entry has `id`, exact `revision`, `purpose`, `owner`, `contexts`, `source`, `bindings`, `validation`, `capabilities`. Unknown fields reject.
- Context rows are `{runtime:"pi",team,mode}`. `*` is explicitly unrestricted. Render requires a matching actual host context; the request cannot supply it. Retrieval reports contexts without asserting permission.
- Source is `{path,sha256,selector}`. Path is contained under `skills/templates/`; digest is of **raw entire file bytes**. `selector` is null or one unique ordered `{start,end}` delimiter pair; only the exact intervening bytes form the template body. Show always preserves the entire raw file.
- Bindings map named placeholders `{{camelCaseName}}` to `{type,required}`. Types: `text`, `multiline`, `ticket`, `repository`, `root`, `path`, `branch`, `sha`, `digest`, `revision`, `handoff`, `json`. No implicit defaults. Missing/foreign/unused/wrong-type/unresolved/duplicate JSON bindings reject. Scalar identifiers reject controls/format injection. Narrative multiline encoding indents each line and preserves CRLF; JSON encoding is explicit, not executable interpolation.
- Validation is `{kind,sections}`. Ordered unique Markdown headings use `sections`; JSON review producers must use their actual `review-matrix` / `review-objective` parser, not generic section checks. `review-bundle` delegates to PAP-271's actual runtime-owned parser.
- Capabilities are `{render,validate,reason,authorityGate}`. An explicit disposition is required even for gated producers. A config flag cannot enable the currently unqualified `pair-signoff`, `handoff-fresh` or `handoff-amendment` runtime contract.

The initial sixteen IDs are the ten canonical document filenames plus `uat-plan`, `handoff-fresh`, `handoff-amendment`, `pair-signoff`, `review-matrix`, `review-objective`. The ten document IDs retain their exact canonical filenames. Directory enumeration is a closure check only: undeclared family files reject, rather than becoming inventory authority. PAP-271 adds one explicitly supported optional extension, `review-bundle`; it does not introduce a competing registry.

Runtime integration must separately pin the approved config revision in `.pa-platform-config.sha` and the raw registry digest in `.pa-template-registry.sha`. The latter is intentionally **absent** until the separately scoped companion is delivered and integrated. It is a content-compatibility pin, **not a workflow enablement toggle**. Missing pins/resources or mismatched bytes reject; no alternate checkout, `PA_CONFIG` or bundled prose fallback exists. `getPlatformHomeDir()` is the existing selected-config resolver. Runtime-owned pins are packaged into the Nix share tree when available; packaging was source-edited, not installed or Nix-qualified here.

The read-only loader authenticates the actual registry/resource bytes against those pins. A config revision in an envelope is not itself a Git-clean/merged claim. The qualification driver separately authenticates selected Git root, HEAD, clean state and committed resource bytes. Joint delivery must also prove merged config provenance and instruction behavior; this checkpoint does not claim it.

Limits: requests 65,536 UTF-8 bytes, registry/source/candidate 1,048,576 bytes, nesting 64. Complete semantic envelopes share a 50-KiB transport cap so native output is never silently truncated; an oversized show/render fails explicitly on both surfaces. Sources reject BOM, malformed UTF-8, symlinks/ancestor aliases, hardlinks, nonregular and changed/oversized files. Diagnostics are schema-owned, bounded and do not echo bodies, secrets, unknown field names or OS exceptions.

## PAP-271 / d-2b2949 integration seam

Read the retained `cd73ff7` checkpoint in PAP-271's `docs/json-workflow-runtime.md`. That route needs legitimate subject production/retention without paragraph authority or another template registry. It can use this exact core interface after integration:

```ts
const host = {
  // Runtime-authenticated selected root/revision/raw registry pin, not agent JSON.
  selection, team, mode,
  reviewBundleConsumer: {
    schemaVersion: "pa-review-bundle/v1" as const,
    validate: parseReviewBundle, // PAP-271's actual supported consumer
  },
};
const draft = templateService({
  action: "render", id: "review-bundle", version,
  bindings: { bundle: exactSubject },
}, host);
```

The companion's `review-bundle` entry uses the same registry, `validation.kind: review-bundle`, a required typed `json` bundle binding, and selected canonical content. No default JSON workflow formatter, copied bundle schema or template-issued decision exists here. A missing consumer gives `TEMPLATE_CONSUMER_REQUIRED`; request fields cannot register it. The CLI and Pi factory expose this same trusted-host seam. PAP-271 must wire its actual parser into its runtime host before exposing this extension in its default public route.

On success `producer` is `pa-template-producer/v1`, binding template ID/revision, raw source digest, config revision, registry digest, bindings digest, exact candidate digest and consumer contract. This receipt is **untrusted provenance data, not importable authority**. PAP-271 must retain the exact candidate bytes through its existing registry owner, authenticate requirement/UAT/matrix bytes and scope at its own boundaries, and capture/issue/revoke decisions through its existing trusted service. Neither `validation.consumer` nor a receipt authenticates referenced evidence, grants requested permissions or enables a workflow. PAPC remains the sole new-run enablement owner.

An implementation-session disposable probe imported the actual PAP-271 `cd73ff7` `parseReviewBundle` and its synthetic bundle fixture read-only from its retained worktree. Fresh and amendment candidates each passed 20 byte-identical repeats and exact validation; eight invalid subjects (uppercase base, wrong ticket, extra remote permission, foreign matrix source across both handoffs) rejected. No sibling mutation, decision, journal write or effect-owner integration occurred. This is cross-source parser compatibility evidence only, not installed adoption, authenticated continuation or a live workflow result. Portable tests separately prove host-port delegation and absence of a caller override; they do not mislabel a spy as the actual consumer.

## Qualification and remaining work

```
node scripts/dev/verify_template_contracts.mjs --mode paired-config
node scripts/dev/verify_template_contracts.mjs --mode selected-installed --binary ppa
```

Both modes require the separately approved pinned companion; absence exits 1 with `status: blocked`. The companion fixture manifest is `contracts/templates-fixtures-v1.json`, schema `pa-template-fixtures/v1`, with exactly one `{id,version,bindings,candidateSha256,context:{team,mode}}` per selected entry. The driver authenticates clean selected content, requires requirements/builder/reviewer instruction discovery, and compares all four public dispatcher/registered-tool operations with 20 repeats per entry. Installed mode additionally requires an actually resolved immutable Nix PPA with matching candidate HEAD/config/registry provenance, then uses that binary and registered native module. It never installs or starts a product. Instruction checking here is discovery-only; behavioral generated-primer checks and merged-config qualification remain companion/joint work. Required producer gates cannot be bypassed by the driver.

Still required before PAP-270 acceptance:

- Separately scoped config companion with actual canonical structural contracts, content, instruction adoption, fixture manifest and approved exact pin integration. Current disposable document fixtures are not proof that canonical content validates.
- Full typed fresh/amendment handoff and finite pair-signoff producers with complete actual-consumer round trips, retained WAW/TTL/NX/legacy evidence and all changed-base/withdrawal/duplicate negatives. Existing legacy compatibility tests stay valid; they do not prove a new producer.
- Complete semantic document/report contracts beyond generic declared-heading checks, all approved mandatory negative/boundary cases, and real generated-primer adoption tests.
- PAP-271 host registration, exact retained subject/evidence integration and its existing decision/progression owners; no circular terminal-ticket dependency or automatic route enablement.
- Exact paired and selected-installed qualification, authorized independent eleven-command matrix, CI and human ten-scenario UAT. Missing prerequisites are blocked, not passing/skipped cases.

The ticket must remain incomplete until those obligations are met. Phase commits are source checkpoints, not readiness or acceptance claims.

## Observed implementation-session checks

- Workspace typecheck and build passed after the source changes.
- Final focused core template suites: 32 passed, zero failures/skips.
- Registered Pi template/composition/tool regressions: 10 passed, zero failures/skips.
- Qualification argument/diagnostic fixtures: 4 passed, zero failures/skips.
- Earlier combined template/retained-baseline/protected-review run: 237 passed, zero failures/skips (before two additional service tests).
- Completions, secrets scan and whitespace checks passed.
- Both actual qualification modes returned `blocked`/exit 1 because the runtime-owned registry pin/paired delivery is absent. Neither selected-installed qualification nor an installation occurred.
- The full workspace test run was started, then explicitly interrupted within the deployment time budget after several suites had progressed. It is **incomplete, not passed**; the session-owned test process tree was stopped. Focused passes do not replace the required full run.
- Independent approved matrix, CI, Nix build, actual canonical producer qualification and human UAT were not performed.

These are source-built/disposable observations only; no mandatory required case is treated as skipped-and-passing.
