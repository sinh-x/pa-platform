# Isolated protected-review contract fixtures

These copies never target live tickets or constitute approval, readiness, migration,
review evidence or new attempt entitlement. All ticket/SHA/source/authorization
identities have been replaced with FIX-237 and synthetic fixture identities.

Historical bounded-section copies (commands are data, never executed):
- `mvm-179-legacy.md`: 2026-10-02-remove-equipment-catalogue.md, generic inline
  commands and unbolded prerequisites; disposable default credential replaced.
- `nx-055-legacy.md`: 2026-10-01-nixos-upgrade-switch-gate.md, bare source and
  unbolded non-Node prerequisites.
- `mvm-181-legacy.md`: 2026-10-02-mvm-181-sqlite-wal-reconciliation.md,
  requirements-prefixed generic source and backend/frontend declarations.

- `pap-234-legacy.md`: 2026-10-01-ticket-worktree-selection.md, generic
  prerequisites and numbered inline commands.
- `dg-438-legacy.md`: 2026-10-11-delivery-address-selection.md, Flutter/Python/Nix
  prerequisites and typed source but unversioned prose matrix.
- `pap-240-legacy.md`: 2026-10-10-pap-240-opt-in-axi-packaging.md, Authority and owner,
  distinct outputs and six AXI/Chrome prerequisites. Operator paths are isolated.

The three originating incident copies' corresponding `*-migrated.md` is a **new synthetic producer document** with
its own exact source/digest and synthetic selected approval comment. Its command
is an inert marker replacing the old matrix, not a migration of historical
execution authority. `producer-node-pnpm.md` copies the approved PAP-237 §12 JSON
field grammar into the fourth synthetic fixture. `readiness.json` tests shape
only, not actual store provenance or PAP-232/PAP-235 completion.

MVM-181 and PAP-231's reported prefixed-source failure is covered by strict exact
prefixed-source positives and bare-path negatives. PAP-235's inline-assignment
boundary is retained in migrated command text; parsing never scans it as an
additional launcher declaration. No live parser/executor/registry is invoked.
