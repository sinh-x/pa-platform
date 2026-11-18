# PAP-318 implementation plan

Source: published r002 requirements and UAT package; original failed deployment d-20c9b0 remains untouched. Branch: feature/PAP-318-pi-primer-file-transport, base 407a87047fdf801b7fecc44a06687c232bbc37a2.

## Phases and commits

1. Characterize real E2BIG and existing configuration exclusions. Commit tests and pre-edit design with the intended-cause red result.
2. Repair uniform shared primer transport, foreground/managed/background/protected-review/resume callers, native admission and file lifecycle. Commit after focused checks.
3. Add explicit version dispatch for a reusable read-only document profile. Preserve fixed historical v1/v2 bindings and route exclusions. Prove committed configuration additions/edits/renames and all three Analyst modes on the same runtime; document the contract. Commit after focused checks.
4. Run integrated typecheck/build/regression and independent review; repair findings and commit the evidence report. Installed pairing, hosted CI, activation, normal-operator retry and human UAT are separate, not implied by local success.

## Pre-edit transport design

The public Pi file processor wraps text in a filename element and strips BOM; piped stdin trims text and changes interactive dispatch. Neither preserves the required initialization contract. Public upstream source inspected through web retrieval: packages/coding-agent/src/{cli/file-processor.ts,main.ts}, 2026-11-18. This is source evidence, not exact installed provenance. Local selected-Pi docs/parser access remains denied by the source-security owner (hardlink qualification), even after an explicitly authorized scoped AgentKit exception; no reader exception or content-copy workaround is permitted.

Use a launcher-owned byte snapshot with a bounded reference (length, digest, physical identity). Expand the reference in JS memory before invoking the existing Pi argument parser, not in another exec argument. The selected immutable host owns expansion after its original native process/source/argument checks. The supported non-selected Node CLI uses a fixed launcher preload only after the existing foreground gate releases; do not add a model-facing file reader or change prompt role. Native kernel cmdline remains bounded; original parser/session/provider/model behavior remains in charge.

Acquire source and snapshot with no-follow, nonblocking regular-file checks, permitted deployment root, current uid, single link, safe mode, exact length, stat-before/read/stat-after and pathname identity. Read at most the explicit byte limit. Child verifies expected identity and digest again and consumes the full UTF-8 content into memory; subsequent pathname mutation cannot substitute those bytes. Reject invalid UTF-8 rather than silently replacing bytes. The snapshot is private and removed on consumption, with supervisor cleanup for unconsumed inputs after verified termination. Protected-review augmentation uses the same path, never a public config/environment body. Integrity metadata is not execution authority, and no hostile-same-uid isolation is claimed.

## Focused commands

- `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test src/__tests__/pi-primer-transport.test.ts`
- Adapter, runtime-start-gate, selected-host, background-runner, protected-review and supported resume suites under packages/pi-pa/src/__tests__.
- Analyst identity, committed source/resource selection, capability policy/parser/plan/session/finite-operation suites under both packages.
- `corepack pnpm typecheck`, `corepack pnpm build`, `corepack pnpm test`.
- `corepack pnpm secrets:scan` on each staged sensitive-workflow commit.

No CLI grammar or production PAPC changes are planned; completions are not affected. No installation, live provider, ticket retry, ticket state change or remote publication is part of these local implementation checks.
