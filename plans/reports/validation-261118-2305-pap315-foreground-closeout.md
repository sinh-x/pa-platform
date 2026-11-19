# PAP-315 revised P3 validation

## Outcome

Actual supervisor-owned cleanup is implemented. The final source passed **262
focused tests**, workspace typecheck/build and separate follow-up source review.
Original product UAT and installed observations are not inferred from this lane.

P1 contract: `7991148`. Initial P2 source: `8c7a354`. This P3 commit includes
three independently identified fixes plus their regressions. Exact final source:

- `packages/pi-pa/src/herdr-exit-cleanup.ts`: SHA-256
  `669755783a16f462c36858f96576ec7035736463f4910252419d2abbc1207d1f`.
- `packages/pi-pa/src/adapter.ts`: SHA-256
  `7a176092eb181aa68640fee5f92fc656ee44aaa9762a16799ef11f023e415941`.

## Independent review and corrections

The first separate code-reviewer examined `0c1404a..8c7a354` and found three
medium-priority defects, despite passing initial tests:

1. A stale report could overwrite the tracked session. Ownership now advances
   only with a strictly newer sequence; A/10, B/12, A/11, C/12 retains B and
   clears with 13.
2. Normal upstream close forcibly destroyed the downstream, potentially dropping
   buffered bytes. Normal EOF now uses graceful pipe completion; errors/disposal
   still destroy owned sockets.
3. Default socket half-close handling could terminate a response when a client
   finished only its request write direction. The relay now permits half-open
   connections. Real local regression fixtures cover delayed 4 MiB replies and
   slow consumers, with and without request write-half-close.

A separate follow-up reviewer examined the exact final hashes and working diff,
confirmed all three fixes, and found no additional actionable defect. It ran
in-memory ownership/duplicate-closeout/sequential-report/large-response cases;
no real sockets, installs or panes. This is independent **agent source review**,
not human approval or installed qualification.

## Actual check results

| Lane | Actual result |
| --- | --- |
| Initial P2 relay suite | 32 passed. |
| Initial P2 combined relay/lifecycle/protocol/adapter/composition/catalogue | 127 passed, 0 failed, 146.67 s. |
| Initial P3 prescribed lifecycle/protocol/deploy/composition plus relay | 242 passed, 0 failed, 243.39 s. |
| Final relay suite after review fixes | 36 passed, 0 failed. |
| Final prescribed lane plus interaction catalogue | **262 passed, 0 failed/skipped, 242.89 s**. |
| Final workspace `corepack pnpm typecheck` | Exit 0. |
| Final workspace `corepack pnpm build` | Exit 0. |
| `corepack pnpm completions` | Exit 0 before review fixes; no CLI grammar/completion source changed afterward. |
| Final `corepack pnpm secrets:scan`, `git diff --check` | Exit 0. |

Final focused command (external 330 s budget):

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/herdr-exit-cleanup.test.ts \
  packages/pi-pa/src/__tests__/herdr-lifecycle.test.ts \
  packages/pi-pa/src/__tests__/herdr-protocol-conformance.test.ts \
  packages/pi-pa/src/__tests__/pi-deploy.test.ts \
  packages/pi-pa/src/__tests__/pi-extension-composition.test.ts \
  packages/pa-core/src/__tests__/interactions-catalogue.test.ts
```

The tests retain the original registry exactly-once/no-Git and three-shape
open-stdin regression, exercise real source closeout waiting before foreground
return, and distinguish acknowledgement from fresh absence. Missing/replaced
socket, uncertain report, sequence reset/reuse/exhaustion, no-op/rejected/
malformed/partial/wrong-ID/oversized response and total deadline behavior are
covered without retry or child-status rewriting.

Session-local logs use `/tmp/pap315-revised-p2-*.log`,
`/tmp/pap315-revised-p3-*.log` and `/tmp/pap315-revised-review-fixes.log`.
Earlier initial passes are not erased by the review findings or later reruns.
The previous full `corepack pnpm test` attempt remains **incomplete**: 600 s
external timeout/exit 124 during pa-core. It was not rerun to completion on this
revision. Full workspace test success and hosted CI are not claimed.

No new PPA CLI wording, grammar, native/model socket tool, capability,
selected-host allowlist or registry-finalization owner was added. The finite
source inventory was renewed for the changed private adapter/helper mechanics,
not as an authority grant. Native cleanup metadata distinguishes uncertain/
acknowledged/verified outcomes and retains an original submitted clear request
ID without raw reply, transcript, socket path or exception disclosure.

The advisory helper initially failed with `ADVISE_SKILL_NOT_FOUND`; no skill
code was repaired. The read-only Explore audit and separate code-reviewer lanes
were used for their own labelled source tasks, not to claim the failed skill ran.

Live installed-pair observations and genuine sidebar/UAT remain P4 evidence.
