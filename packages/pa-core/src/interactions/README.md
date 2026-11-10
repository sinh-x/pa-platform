# PA interaction foundation (PAP-282)

This directory is a **source-only foundation**, not the completed PAP-282
interface. It does not execute CLI commands, grant permissions, select a new
writer profile or alter any retained tool schema. The Pi adapter exposes the
source reader as `pa_capabilities` only during a native-proven advisory start;
that registration is not installed qualification or an expanded ticket writer.

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
- `source-inventory.json`: hashes of 39 dispatch/CLI/native owner sources. Tests conservatively
  require reconciliation when any tracked source changes or a command file is
  added. Hash equality is not semantic coverage, installed provenance or approval.

For example, `health.report` is a read while `health.save` is a write delegated to
its existing owner. `status.wait` and `serve.status` are not safe substitutes
for native reads: their existing CLI implementations can reconcile lifecycle
state or remove stale PID state. Signal dry-run
remains sensitive/operator-only even when it does not persist results.

Every native/delegation binding and operation request/result schema reference is
currently null. Consumers must not convert a target disposition into an available
tool. `SOURCE_ONLY_AVAILABILITY` keeps configured, installed, session registration,
availability and admission separate and explicitly unproven/not checked.

## Remaining P1 work

This is not an exhaustive operation qualification. Finish semantic reconciliation
of supported help forms, positional aliases, option combinations, implicit effects
in imported domain services and concrete role/mode cells. Native-only
workflow/decision/document/workspace/preparation/execution/report actions are
listed separately by channel; they are never advertised as CLI subcommands. Add typed family request/result schemas and their owner bindings
as those services are implemented; do not populate references with proposed names.
The source-only reader is not a runtime capability service: role filters,
visibility/admission observations and installed provenance remain unimplemented.
The raw JSON TypeBox wrapper is in `packages/pi-pa/src/pi-extension/capability-tool.ts`;
minimal core exports expose only the reader and bounded input/error contracts.
Retained document/v1/v2/v3, pinned, unmarked and other non-advisory starts do not
acquire this new registration or any additional write permissions.

For a changed CLI source, inspect the handler and its affected domain calls,
reconcile IDs/forms/effect boundaries and add negative tests **before** updating
its source digest. Never refresh hashes solely to silence a failing test. The
independent high-risk invariants are additional regression checks, not a complete
permission engine or exhaustive command parser.

## Ticket-owner creation primitive (not yet a native writer binding)

`TicketStore.createWithIntent` extends the existing ticket owner, not the
interaction catalogue. It accepts trusted adapter-supplied caller scope, stable
request ID and a mandatory reauthentication callback under the same mutex used by
ordinary ticket writers. It is not reachable from a new tool yet; raw request
validation, role selection, registered-project scope and explicit companion
intent still belong to the future admitted adapter/service.

The ticket store owns immutable `.ticket-create-<digest>.json` intent records
beside its existing counter/ticket/audit files. These are idempotency data, **not
permissions, approvals or a second adapter replay database**. An intent reserves
one exact ID and complete candidate before counter, ticket and audit effects.
All ordinary ID allocation skips these reservations. Candidate and counter writes
are atomic; the new primitive writes its audit through the same atomic file
boundary, and reports success only after ticket/audit readback. `reused` refers to
an existing intent and does not claim a recovery performed no remaining effects.

An interrupted original intent can finish missing proven steps. Conflicting
payload/actor, malformed intent/candidate/audit, a deleted or moved ticket, and
unsafe file aliases are not silently normalized, overwritten or treated as
absence. Unknown reservation data blocks dependent creation (including ordinary
ID allocation); it never authorizes deleting evidence or retrying with a fresh
identity. Existing document-v1/v2/v3 tag-based intake is not migrated or widened.

Disposable tests cover response loss, interruption after intent/ticket/audit,
ordinary-writer reservation coexistence, real concurrent owner processes,
conflicting payloads, stale caller callbacks, corruption and symlinks. They are
not a genuine native foreground creation journey, exhaustive crash/power-loss
qualification, source-owner authentication or full CLI/native parity.

## Focused checks

From the repository root:

```sh
corepack pnpm exec tsx --test packages/pa-core/src/__tests__/interactions-contract.test.ts packages/pa-core/src/__tests__/interactions-catalogue.test.ts packages/pa-core/src/__tests__/interactions-discovery.test.ts
corepack pnpm typecheck
```

These source checks do not establish installed exposure, CLI/native end-to-end
parity, independent review, hosted CI or actual human UAT. P2–P7 and remaining P1
obligations must still be delivered and verified before umbrella acceptance.
