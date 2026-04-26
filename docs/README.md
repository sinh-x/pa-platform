# pa-platform Docs

This directory holds documentation, examples, and non-active reference material for the pa-platform monorepo.

Active runtime configuration stays outside this directory:

- `teams/*.yaml` contains active team definitions.
- `teams/<team>/modes/*.md` contains active mode objective files that are read into deployment primers.
- `skills/global/*/SKILL.md` contains active global skill definitions used by primer generation.

Examples and explanatory docs live under `docs/` so they are not accidentally loaded as active team configuration.
