# PA interaction foundation (PAP-282)

This directory is an **unregistered, source-only foundation**, not the completed
PAP-282 interface. It does not execute CLI commands, register Pi tools, grant
permissions, select a new session profile or alter any retained tool schema.

The approved product scope lives in PAP-282's six-member
`pap-282-full-cli-interactions/r001` requirements package. This code begins P1;
it does not replace that package or narrow its acceptance criteria.

## Contents

- `contract.ts`: versioned discovery `list`/`describe` request union, shared JSON
  Schema and strict raw JSON parser. Unknown/duplicate fields, invalid Unicode,
  excess bytes and execution/identity overrides reject before dispatch. It reuses
  the existing strict JSON reader without changing that reader's consumers.
- `discovery.ts`: bounded source-only listing/description over an immutable reader
  snapshot, with integrity-protected, reader/view/query-bound continuations. It
  does not inspect installed tools or runtime permissions. A fresh reader requires
  a fresh listing; a cursor never authorizes effects or access to runtime data.
- `catalogue.ts`: data-only target dispositions for core/PPA families and selected
  effect variants. `cliForms` are schematic inventory labels, **not runnable
  commands or an argv grammar**. `targetDisposition` is product intent, not
  current availability. No generic forwarding/dispatch exists.
- `source-inventory.json`: hashes of 29 dispatch/CLI sources. Tests conservatively
  require reconciliation when any tracked source changes or a command file is
  added. Hash equality is not semantic coverage, installed provenance or approval.

For example, `health.report` is a read while `health.save` is a write delegated to
its existing owner. `status.wait` is not a safe substitute for a native read:
its existing CLI implementation can reconcile lifecycle state. Signal dry-run
remains sensitive/operator-only even when it does not persist results.

Every native/delegation binding and operation request/result schema reference is
currently null. Consumers must not convert a target disposition into an available
tool. `SOURCE_ONLY_AVAILABILITY` keeps configured, installed, session registration,
availability and admission separate and explicitly unproven/not checked.

## Remaining P1 work

This is not an exhaustive operation qualification. Finish semantic reconciliation
of supported help forms, positional aliases, option combinations, implicit effects
in imported domain services, native-only document/workspace actions, and concrete
role/mode cells. Add typed family request/result schemas and their owner bindings
as those services are implemented; do not populate references with proposed names.
The source-only reader is not a runtime capability service: role filters,
visibility/admission observations and installed provenance remain unimplemented.
No TypeBox adapter or public core export has been added.

For a changed CLI source, inspect the handler and its affected domain calls,
reconcile IDs/forms/effect boundaries and add negative tests **before** updating
its source digest. Never refresh hashes solely to silence a failing test. The
independent high-risk invariants are additional regression checks, not a complete
permission engine or exhaustive command parser.

## Focused checks

From the repository root:

```sh
corepack pnpm exec tsx --test packages/pa-core/src/__tests__/interactions-contract.test.ts packages/pa-core/src/__tests__/interactions-catalogue.test.ts packages/pa-core/src/__tests__/interactions-discovery.test.ts
corepack pnpm typecheck
```

These source checks do not establish installed exposure, CLI/native end-to-end
parity, independent review, hosted CI or actual human UAT. P2–P7 and remaining P1
obligations must still be delivered and verified before umbrella acceptance.
