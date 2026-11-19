# Phase 3 — configuration-driven read-only profile

Implemented explicit `pa-readonly-document/v1`, binding v3 and a distinct native session marker. PAPC owns actual public team/mode, agent, workflow/resource and selected-capability definitions; runtime retains fixed effective requirements/analyze attribution and finite native effect owners. Historical v1/v2 binding serialization/semantics remain separate. No production team or PAPC configuration was modified.

Detailed implementation, consumer inventory and initial checks: ../reports/phase-implementation-261118-2134-pap318-phase3-readonly-profiles.md. Contract and inert authoring example: ../../docs/readonly-document-profile.md.

## Independent review and repairs

Read-only review: ../reports/code-review-261118-2227-pap318-phase3-readonly-profiles.md. It verified 53 focused tests and byte-equal historical v1/v2 serialization, but found a blocking missing-mode fallback: a profile-only team without default_mode could fall through to an unbound generic start. It also found coercion accepting enum arrays.

Repaired both before this phase commit. Launcher and immutable planner now reject a profile-only team unless a profile mode resolves. Missing-mode requests (normal and dry-run) reject before adapter probes/allocation for analyst, evidence-lab, builder and requirements spellings. Explicit mode selection still works without a default on the same real production adapter. Enum validators require actual strings; array/object/number/null/boolean negatives were added. The runtime contract now documents the explicit-mode rule.

## Checks actually completed

- Main-agent phase 3 verification before repairs: core profile/origin/plan 27 passed; Pi profile/ticket/production-adapter 11 passed, NO_COLOR.
- After review repairs: pa-core build passed; the same core suites passed 27/27; Pi suites passed 12/12 including the new missing-mode matrix and positive no-default explicit-mode real launch. Logs: /tmp/pap318-phase3-review-{build,core,pi}.log (ephemeral).
- Phase 2 final focused suites, rerun while profile implementation proceeded: 111 passed, zero failed. Log: /tmp/pap318-phase2-final-focused.log. This does not substitute for the final integrated candidate run.
- Implementation-agent checks and their two external-fixture skips and long-suite timeouts are preserved in its report; no timeout is called a complete-suite pass.

The profile fixture uses one unchanged runtime/adapter across committed additions, agent/objective/capability edits and team/mode renames. All three Analyst modes run with and without a supplied synthetic ticket; inert children verify >635831-byte exact primer digests, bounded kernel argv/environment, selected resources/tools/public identity, actual process anchors and replay-safe ticketless intake without primary reassociation. Unsupported writer effects, environment aliases, source drift and excluded launch classes remain rejected.

No installed package, live provider, canonical PAPC activation, ticket retry, hosted CI or human acceptance is established. Phase 4 owns final integrated checks and review reconciliation.
