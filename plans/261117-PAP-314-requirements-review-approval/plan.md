# PAP-314 implementation

## Outcome and revised scope

Implement runtime capabilities for complete requirements review and finite publication/ref/link/queue. Reuse PAP-312 owners. Commit each P0–P5 phase separately. No product install, activation, push, merge, implementation launch or live historical-ticket repair.

Sinh changed two requirements during this implementation session:

- Keep trigger/approval simple **without authentication for now**. New local decisions must say `local-unverified`; they are not authenticated human consent. Retained native contracts keep their original semantics. Loopback, strict schemas, exact subjects, CAS, immutable history and finite effect guards remain required.
- Change only runtime source. PAPC source/default selection belongs to follow-up **PAPC-090**, created at Sinh's request. Do not edit its canonical repository or activate defaults.

## Phases

- [x] P0: versioned local confirmation/continuation contract and independent review. Three initial transition gaps corrected; independent contract re-review passed. PAPC-090 created.
- [x] P1: shared local confirmation owner, Pi/CLI/loopback API bindings and tests. Focused checks passed after dependency/actor integration corrections; P3 effects deliberately remain closed at this boundary.
- [x] P2: summary-first entry with complete member pages, raw sources, full offline view and bound opening. All 34 reader/worker/opening tests passed; actual browser/human accessibility remains unverified.
- [x] P3 source implementation and R1–R4 repairs: custody admission, pre-ref preconditions, exact native link attribution and revoked original queue settlement have passing registered/core source checks. See phase-03-finite-handoff.md and plans/reports/repair-261117-0434-pap-314-p3-r1-r4.md. Independent re-review passed with all seven original counterexamples and combined suites green; this is not installed/default-entry or human acceptance.
- [ ] P4: runtime selection/discovery/compatibility contract and PAPC-090 handoff; no PAPC source mutation.
- [ ] P5: source verification, independent review and honest installed/CI/browser/human qualification accounting.

## Validation

Use disposable real Git, TicketStore and registry fixtures. Run focused tests per phase, typecheck/build and broader regression where feasible. Stage only phase-owned paths; run `corepack pnpm secrets:scan` and `git diff --check` before every sensitive phase commit. No live database mutation is required; any authorized live schema/data change first requires a backup. Source tests are not installed/human acceptance. Record missing required evidence rather than promoting it to a pass.

## Session constraints

CWD `/home/sinh/.treehouse/pa-platform-cdb114/6/pa-platform`; timezone Asia/Saigon; language en_US.UTF-8. Narrow recursive searches and cap matches. Markdown only under this checkout's plans/ or docs/.
