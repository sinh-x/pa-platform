# PAP-273 — startup/diagnostics source increment

This is a **partial source delivery**, not completed PAP-273, installed policy,
requirements/UAT approval, execution readiness or acceptance. It builds on
`b09366977463d607264bc3b2ed9ccc55283554cf` on
`feature/PAP-273-workflow-startup-compatibility`. PAP-271/PAPC-072 history and signed
evidence are unchanged.

## Delivered behavior

| Boundary | Required evidence |
| --- | --- |
| Selected workflow inspection | Existing selected route, definition/schema, declared capabilities and actual registered operations; no fallback or enablement override |
| Repository/profile observation | Ticket-owned registered repository context, even without a subject/run; no command execution or confinement probe |
| Canonical drafting, admission and subject revision | Existing real template producer/parser, exact selected pair, subject/artifact/matrix identities; no implementation-time project-command contract prerequisite |
| Package decision, publication and queue | Existing exact-subject decision, permissions, ticket/publication owner and reconciliation checks; a missing/unsupported project profile does not prohibit approved queueing |
| New source/check effect request | Supported project profile required before owner admission or durable intent creation; native executor still validates actual commands, scope, approved checks, inputs, custody, trusted executables and confinement |
| Retained reconciliation | Existing same-intent owner/proof checks, unchanged; no profile deferral authorizes a new effect or fabricates a historical result |

`projectProfile` distinguishes `supported`, `missing`, `unsupported` and
`uninspected`. Supported means **static contract inspection**, not a successful
namespace probe or execution admission. No repository context is not evidence of a
missing contract. Malformed, foreign or unsupported observed contracts do not
become supported through deferral.

`preflight.gates` contains current selection/producer/subject blockers.
`preflight.executionPrerequisites` separately exposes later project-execution
blockers; it does not participate in requirements admission. All public views
retain `executionAdmitted: false`. Queue status alone is not execution readiness;
workflow status/next expose the current execution prerequisite separately.

`status` and `next` with no retained run now return `selected-without-run` (or
`selection-blocked-without-run` for an unavailable/disabled binding), `runId: null`
and observational preflight. They do not admit a run, manufacture decisions or
repeat prior approvals. A sticky workflow marker with missing retained evidence
still fails as `WORKFLOW_UNCERTAIN`, not an ordinary fresh startup.

Admitted views identify `runState: admitted`, retain original state/history and
show the current project-execution blocker. Retained preflight uses the pinned
workflow definition rather than silently selecting the current binding. Revoked,
stale, unknown and pending states retain their existing authority/evidence rules.

## Causal diagnostics

Template-pair, resource, capability, context, version and missing-consumer failures
are mapped to bounded native cause codes and owning gates, not a misleading
missing-producer report. `TEMPLATE_PAIR` survives registry observation, producer
rendering and service admission/revision. Neither exception bodies nor bindings
are copied into workflow diagnostics. Pair remediation explicitly belongs to the
config/runtime owner; status/next retries and repeated human questions cannot fix
it. Unrecognized failures remain redacted and fail closed.

Missing/unreadable physical selected team identity is now a typed pair failure,
not a raw filesystem exception. **Exact package/config/registry pin checks remain
in place.** This increment does not implement or approximate the approved
compatibility redesign by deleting equality checks.

## CI split

The retained `2d4de2409b73ae5dacb931a66910e29d00145b4c` design is integrated without
cherry-picking its historical branch or creating a commit. The layout is adapted:

- `pi-workflow-code-cases.ts`: portable cases and shared disposable fixture.
- `pi-workflow-runtime.test.ts`: imports those cases and directly/unconditionally
  registers all seven native direct cases and all nine native matrix cases.
- The code runner explicitly substitutes the portable entry and reports the full
  entry as mandatory manual integration, never as passed or skipped.
- Inventory tests reject stale, missing, duplicate or ambiguous replacements.
- A copied, untrusted Node executable runs the portable entry while the real
  project-command executable trust check still rejects that executable.
- All eleven original direct test bodies and shared setup were compared against
  the base using the TypeScript AST; native test bodies were not weakened.

The installed verifier still names the full entry and requires every existing
case anchor. It additionally requires both new startup test files and the
stage-separation/causal-diagnostic anchors (19 qualification rows rather than 17).
Omitting any new anchor also fails accounting. No trusted-executable/confinement
guard or mandatory native case was removed. A loader unit regression now creates its own disposable committed source
fixture, so local edits do not masquerade as source substitution in that *unit
fixture*. Actual candidate/installed verification is unchanged and still rejects
dirty/substituted source. The regression explicitly tests that rejection.

## Verification and limits

Source checks in deployment `d-555e7d`:

- Typecheck/build passed; generated completions are unchanged.
- Affected workflow/template/core/Pi regressions passed 155/155 with zero skips.
  The full workflow entry separately passed 35/35 with zero skips, including all
  16 mandatory native cases.
- Script regression entry passed 24/24 after the loader fixture correction.
  Native legacy project-command-contract tests separately passed 21/21 with zero
  skips, retaining trusted executables, input drift and confinement rejection.
- The full core suite finished: 1,553 passed, 14 existing optional skips, zero
  failures (1,567 tests). The code-only core subset separately finished with 1,493
  passed, the same 14 optional skips, zero failures (1,507 tests).
- OpenCode finished with 104 passed, one existing optional skip, zero failures;
  runtime-host's architecture test passed.
- The full workspace run timed out at 1,500 seconds during Pi tests; it is **not a
  pass**. It exposed an inherited-admission fixture missing its authenticated
  ticket. That fixture was corrected and its focused regression passed; the
  complete workspace run was not subsequently certified green.
- The workspace code-only run timed out at 600 seconds; a separate Pi code-only
  run timed out at 900 seconds. These are incomplete results, not successful CI.
- The supplied secret scanner exited zero but scans staged files only; no files
  were staged, so that invocation does not certify the working-tree diff.

Actual source-built CLI observation for PAP-273 still reports selected revision
`c614cfd385a03a2b0f6b5697046e374a2ca1811e`, requirements-to-builder/r001,
`projectProfile: missing`, a separate execution prerequisite, and the real
`TEMPLATE_PAIR` startup blocker. Source-built status reports
`selected-without-run`, not a broken admitted run. Template retrieval still
rejects the mismatch. The existing installed native host still exposes the old
premature project/producer gates: **no install/reload occurred**. Source tests and
synthetic native registration are not exact installed/fresh-host qualification.

## Remaining PAP-273 work (not delivered here)

1. Implement/review coherent compatible config selection and full committed
   resource closure without package-HEAD coupling; retain exact original
   templates/instructions/resources per run, and block unsupported legacy gaps.
2. Implement versioned repo-local command catalogues with explicit legacy/local
   source conflict/adoption semantics and task-required-check selection.
3. Implement bounded ticketless `repo-setup`, writer exclusion and fixed-path
   candidate writes; coordinate companion team/instruction changes through their
   config owner, without cross-repository writes from this checkout.
4. Implement managed-agent-denied operator CLI approval, hidden fresh password
   verification, protected native evidence, credential rotation/reset/revocation
   and exact local Git-exclude reconciliation. No such command or credential
   feature is available from this increment.
5. Finish complete portable/native/local runs, obtain actual hosted results after
   separately authorized remote integration, establish an exact Git candidate and
   package provenance, and separately authorize build/install/selection/reload.
6. Perform supported paired installed/fresh-host qualification, independent
   matrix/review and genuine human UAT/adoption. Source-built results cannot be
   grandfathered into those gates.
7. Resume NX-067/TTL-017 only at their first unproven actions through their owners;
   preserve prior decisions, link/history evidence and live foreground custody.

No config/pin edits, application changes/dependencies, project onboarding,
credentials, installation, workflow admission, device operation, production deployment launch,
remote writes, acceptance claim or checkout return were performed by this work.
The selected checkout and its existing lease remain retained.
