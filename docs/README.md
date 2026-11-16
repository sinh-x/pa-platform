# pa-platform Docs

This directory holds documentation, examples, and non-active reference material for the pa-platform monorepo.

Active runtime configuration stays outside this directory:

- `teams/*.yaml` contains active team definitions.
- `teams/<team>/modes/*.md` contains active mode objective files that are read into deployment primers.
- `skills/global/*/SKILL.md` contains active global skill definitions used by primer generation.

Examples and explanatory docs live under `docs/` so they are not accidentally loaded as active team configuration.

## Repository Standards

- [Human-Facing CLI Message Standard](cli-message-standard.md) defines outcome-first PPA/OPA wording, bounded blocker guidance, and review criteria for future authorized message changes. It does not change runtime or machine-output contracts.
- [CLI standard announcement](bulletins/PAP-246-cli-message-standard.md) explains when agents and maintainers should use the standard; informational repository documentation, not a live PA bulletin.
- [PAP-246 rollout record](PAP-246-documentation-rollout.md) records phased commits, document checks, retained-source provenance, and external distribution boundaries.

## Operational Docs

- [PAP-303 source-access audit](PAP-303-source-access-audit.md) records the rogue-one/builder workflow distinction, observed multi-link source denials, proposed owner-scoped repair and incomplete P1–P4 status.

- [PAP-303 source-checkpoint integration](PAP-303-integration-status.md) records default-off lifecycle, effect-free peer hardening, restored finite source scope and separate remaining contract/security/installed/UAT gates. [Source-denial history](PAP-303-source-denial-root-cause.md) retains the original investigation; its broad store-admission experiment was withdrawn, and guard-marker reporting is observation rather than enforcement attestation.

- [PAP-302 runtime phases](PAP-302-runtime-phases.md) records P2–P4 implementation and P5 source hardening. The [qualification handoff](PAP-302-qualification-handoff.md) separates actual checks/timeouts from unperformed manual pairing, installed/independent/desktop/canary/human gates; [P1 evidence](PAP-302-auto-waitlist.md) remains historical.

- [PAP-273 native confirmation and branch bridge](PAP-273-native-confirmation-follow-up.md) records the d-199e82 follow-up, source interfaces, phase results, retained-version behavior and separate installed/UAT gates.
- [Requirements workspace interfaces](requirements-workspace-interface.md) separates V2 and V3 supporting capabilities and operator/model entry points.

- `advisory-runtime.md` documents PAP-277's result contract, gate inventory, new-run integrity and retained compatibility.
- `PAP-277-qualification.md` records the exact installed verifier/PAPC interface and separates source checks from unproven rollout acceptance.

- `release-process.md` documents version bumping, tagging, and CI release expectations.
- `prepared-autonomous-runtime.md` records PAP-256's inactive core preparation/capacity implementation and remaining delivery boundaries.
- `opencode-primer-parity-matrix.md` records the PAP-022 Old PA versus pa-platform primer-generation audit.
- `sanitize-and-file-inputs.md` records current sanitization/file-input behavior and the recommended low-friction safety policy.
- `dashboard-phase1-uat.md` records local read-only dashboard UAT checks and route-level expectations.
- `hermes-pa-skills-dashboard-phase5.md` records PAP-078 Phase 5 packaging, boundaries, fixture coverage, and full verification commands.

## Historical Design Proposals

- [PAP-282 session-only external-read proposal](PAP-282-session-external-read-design.md) preserves an unimplemented design from the v0.1.159 baseline. Its dated disposition distinguishes newer ordinary-read support and PAP-298's separate guarded-document work; it is not an active implementation handoff or runtime permission.
