# PAP-283 installed document-package qualification

Status: verifier source implemented. **No selected-installed pass, genuine foreground trial, human approval or UAT is implied.** This lane is separate from the historical JSON-workflow and PAP-277 advisory qualifiers.

## Exact command and prerequisites

From the exact clean built runtime candidate checkout:

```sh
node scripts/dev/verify_document_runtime.mjs --selected-installed \
  --require-candidate "$DOCUMENT_RUNTIME_SHA" --require-paired-config
```

`DOCUMENT_RUNTIME_SHA` must be the full lowercase 40-hex commit of this checkout. Only these four ordered arguments are accepted. There is no source mode, binary/module/config-root/result-file/skip override, abbreviated `HEAD`, imported approval or caller-supplied passed flag. `corepack pnpm verify:document-installed` invokes the same driver.

The actual PATH-selected `ppa` and `opa` must resolve into the same immutable Nix package. Its `review-runtime-provenance.json` must name **exactly** the clean runtime SHA and build-pinned PAPC SHA, not `unversioned-dirty-source`. Package version alone is not fidelity. Every non-test implementation module, package manifest, lockfile and adapter core dependency must agree with the source build. Cached TypeScript/tsx and a matching native SQLite addon must exist. No downloads/install/activation are performed by this verifier.

The actual selected PAPC home/teams, clean HEAD and registry digest must agree with the runtime-owned `.pa-platform-config.sha`/`.pa-template-registry.sha` and installed copies. PAPC must supply `requirements/analyze.document_profile: pa-document-package/v1`, the nonempty canonical `skills/global/pa-requirements-workflow/SKILL.md`, and exactly one non-reference `global-skill` or `shared-skill` injection of that canonical skill in the analyze mode. The installed composer must actually include it once. All selected committed instruction/template resource identities and the generated primer are retained and rechecked. This proves exact bytes/structural dispatch, **not semantic completeness of the instruction closure**; PAPC composition/mutation tests remain mandatory.

A legacy or advisory-only PAPC revision cannot pass this lane by rendering the interface. A changed PAPC candidate needs a deliberate exact runtime build-pin refresh and new package build through its owners. Never rewrite installed provenance or copy a new descriptor into an older package to obtain green results.

## Mandatory execution inventory

The controlling inventories are `DOCUMENT_CASES` (45 exact names **and source owners**), `DOCUMENT_ENTRY_CASES` (13 default public observations) and four prerequisite/integrity groups in `scripts/dev/verify_document_runtime.mjs`. All 62 IDs are mandatory. An omitted/renamed/duplicate/foreign-owner/failed/skipped/todo/cancelled case or invalid native test summary blocks. Passing historical advisory or graph cases does not satisfy a document ID.

The pinned private driver harness copies/transpiles **test and fixture code only**. Every product implementation import, including child worker paths, bridges to the exact verified installed module. Existing import auditing rejects source fallback, altered bridges and installed module substitution. Required imported document contract/service/tools/registry/publication and Pi session/native/tool/CLI modules must actually be observed, not just present in an inventory.

The 45 required document cases cover extensible contracts and all members/effect scopes, strict raw inputs, ticket-first intake, immutable successor/feedback comparison, local failed-check isolation, stale/foreign/forged decisions, every nonapproval, source/path/media/alias negatives, full-set-before-primary, predecessor integrity, no lifecycle downgrade, uncertain-intent lineage exclusion, revocation without approval resurrection, full paged Markdown, real competing publication processes, process death at three publication boundaries, lost queue replies and exact settlement, native presentation/caller/incarnation/abort, role/tool confinement, bounded result correlation retained selection and fresh-document primer isolation without changing retained/OPA runtime projections.

A separate pinned child exercises actual installed public CLI and **default native tool registration/host**, with no injected `mutate`/authentication/capture implementation. Its registry launch/session/process anchor and UI responses are explicitly disposable fixtures:

1. Actual `ppa document describe --format json`, compared with the installed shared contract.
2. No CLI capture/publication/approval import.
3. No advertised new native OPA document parity.
4. Lazy registration from the default native session module.
5. Actual isolated ticket-first creation and same-ID retry.
6. Native draft/check plus opaque PNG snapshot support (fixture-owned media setup, not an image editor/viewing claim).
7. Exact snapshot, status recovery and complete immutable text reads.
8. Changed bytes during synthetic foreground consent refuse persistence.
9. Exact default-native decision evidence and forged-outcome rejection.
10. Complete five-member publication and primary proof through real owners.
11. Queue and repeat observation without duplicate audits or builder launch.
12. Actual role hook denies shell/source/preparation/execution surfaces.
13. Unmarked retained session is not upgraded and its state is preserved.

This is **installed disposable mechanics**, not genuine normal Pi launch/provider behavior or human consent. Synthetic answers against an isolated ticket must never be represented as approval of PAP-283 or a live package. Full real foreground TS-1–TS-18, independently reviewed source/CI and Sinh UAT remain separate requirements.

## Results and unchanged-state proof

The unsigned `pa-document-installed-qualification/v1` report is bounded to 50 KiB. It records actual source/config/package/module/provenance/addon/driver/import/test-event identities, 62 case states, limitations and an external private evidence directory. Complete resource inventories, selected primer and native failure/stdout/stderr/import logs remain in mode-0600 evidence files rather than being silently truncated into a partial approval.

Before disposable execution, missing prerequisites leave cases `not-run`. Attempted cases become `unknown` until actual native events/public observations prove them. A failure/timeout remains nonzero and preserves original logs. Unknown cleanup is not certified as absence or success. At completion the source/config cleanliness and commits, selected configuration, resources, build pins, immutable binary/provenance and implementation module inventory are rechecked.

The report never grants runtime authority: `installationPerformed`, `enablementPerformed`, `humanApproval`, `humanUat` are false. A local built-driver unit regression verifies harness/accounting/public mechanics without invoking the public qualifier and **is not** installed qualification. The public path has no source-mode bypass.

## Validation lane separation

See [requirements-validation-lanes.md](requirements-validation-lanes.md) for explicit `PA_PLATFORM_REPOSITORY` setup and separate exact legacy/new-profile runtime and PAPC checkouts. The unchanged legacy exact pin `62b0f4162aab59d3ec69228e9e7ba3f9c91d1b78` belongs to historical JSON-workflow tests, not this PAP-283 candidate. Preserve those assertions and results; never point every test at a moving runtime or edit retired behavior checks simply to make the aggregate green.
