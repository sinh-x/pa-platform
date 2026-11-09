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

- `advisory-runtime.md` documents PAP-277's result contract, gate inventory, new-run integrity and retained compatibility.
- `PAP-277-qualification.md` records the exact installed verifier/PAPC interface and separates source checks from unproven rollout acceptance.

- `release-process.md` documents version bumping, tagging, and CI release expectations.
- `prepared-autonomous-runtime.md` records PAP-256's inactive core preparation/capacity implementation and remaining delivery boundaries.
- `opencode-primer-parity-matrix.md` records the PAP-022 Old PA versus pa-platform primer-generation audit.
- `sanitize-and-file-inputs.md` records current sanitization/file-input behavior and the recommended low-friction safety policy.
- `dashboard-phase1-uat.md` records local read-only dashboard UAT checks and route-level expectations.
- `hermes-pa-skills-dashboard-phase5.md` records PAP-078 Phase 5 packaging, boundaries, fixture coverage, and full verification commands.
