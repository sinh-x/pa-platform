# Team Examples

Team examples are templates only. They are intentionally kept outside `teams/` so `pa-core` does not list them as deployable teams.

To create a new active team:

1. Copy `docs/examples/teams/example.yaml` to `teams/<team>.yaml`.
2. Update `name`, `description`, `deploy_modes`, `agents`, and `objective`.
3. Put any mode objective files under `teams/<team>/modes/*.md`.
4. Keep runtime/provider-specific behavior in adapter config where possible.
