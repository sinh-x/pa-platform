# Phase 1 — characterization

2026-11-18, source base 407a87047fdf801b7fecc44a06687c232bbc37a2, Node v22.23.4, pnpm 10.28.0, Linux.

- `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test src/__tests__/pi-primer-transport.test.ts`: exit 1, one pass and one intended-cause failure. A real inert Node exec of one 635831-byte argument returned E2BIG. The actual PiAdapter shared production spawn also failed with `spawn E2BIG` at adapter.ts:681 before the inert target could execute. No mocked runCommand/provider/live ticket was used. Original console log: /tmp/pap318-phase1.log (ephemeral).
- `corepack pnpm --filter @pa-platform/pa-core exec tsx --test src/__tests__/analyst-identity.test.ts`: exit 0, four tests. Existing parser characterization explicitly rejects investigate and a renamed team; fixed v2 identity rejects research and privilege widening. This captures the analyze-name restriction separately from E2BIG. Log: /tmp/pap318-config-baseline.log (ephemeral).

The failing launcher test is deliberately committed before its repair; it is not a passing acceptance claim. Public upstream source demonstrates @file wrapping and stdin trimming. Exact installed parser/document access remains denied by the native local-source owner; no installed-source or installed-package success is claimed. The operator authorized a Pi-package-only AgentKit guard exception outside the repository; native source qualification still rejects those files. No generic hardlink/Nix exception was added.

No live deployment history, ticket status, canonical PAPC configuration, provider or installed package was modified.
