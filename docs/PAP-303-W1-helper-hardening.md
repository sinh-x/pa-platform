# PAP-303 W1 — effect-free helper hardening

Date: 2026-11-16. Deployment: `d-b59414`. Branch:
`feature/PAP-303-herdr-trusted-bridge`; retained HEAD
`66629b6d2afdc44e3f9c346440f40791c3a9aeb5`. Changes are uncommitted.

**Outcome: W1 helpers and focused regressions are hardened. Peer messaging remains
unavailable. Broader qualification is incomplete; this is not full P1/PAP-303
acceptance.**

## Scope and retained work

Sinh selected W1 implementation based on
[the d-2d2cef handoff](../plans/261116-1541-pap303-follow-up/d-b59414-handoff.md),
then explicitly instructed continuation in this same deployment instead of
launching another writer. Repository mutations are confined to the existing
feature worktree `/home/sinh/.treehouse/pa-platform-cdb114/15/pa-platform`.
Canonical `develop`, deployment registry bindings, linked-HEAD metadata and leases
are unchanged; no native rebind or protected builder-custody admission is claimed.

The adopted unfinished exchange helper initially had SHA-256
`b9a1f94d4f0383351bfb66130885dfa6a02f1d821754549e10a53442c1bfea36`.
Its conservative rewrite was preserved and completed, not reset to the old green
checkpoint. The pre-existing follow-up plan and untracked d-2d2cef handoff are
preserved unchanged. No new deployment was launched. Earlier dry-run selection
attempts were rejected before launch; they are not a writer/readiness grant.

No source-policy widening, lifecycle activation, PAPC/NX configuration change,
request tool, peer submission, installation, commit, push or ticket-status change
is part of this W1 checkpoint.

## Disposition of monitor findings

| Finding | Source-only W1 disposition | Still not established |
|---|---|---|
| F1: false reply attribution | `classifyPeerReply` never returns `correlated`. Even nonce + settled state + counter advancement yields `unverified/unframed-channel`. All outcomes return bounded measurement metadata only; there is no `reply` body. Echoed input, forged reply labels, unrelated completions and terminal controls cannot become a returned peer response. | A supported identity-bound agent-context receiver and explicit matching response channel remain W3 work. Renaming a status is not transport/provenance proof. |
| F2: invalid states/counters | Allowlist `idle`/`done`; truthful failures for working/blocked/unknown/invalid states. Both counters require explicit nonnegative safe integers and strict advancement. | Ordering still proves no request-specific response or consent. |
| F3: UTF-8/request bounds | Preserve code-point-safe tail truncation and final encoded size checks. Enforce 80 lines AND 16,384 bytes for private measurements. Request planning preserves the body intact and caps the entire planned JSON parameter object, including nonce, target, wait and JSON escaping, at 4,096 bytes. Oversized whitespace cannot be trimmed into acceptance. | No read/send exists. A future transport owner must include its additional RPC framing in the same request budget and enforce the total monotonic deadline; a planned wait timeout is not that owner. |
| F4: unknown target facts admitted | Rename the preliminary function to `observePeerTarget`, returning `observation`, not `admission`. Require explicit readiness/no pending launch, known counters and a supported session-path observation; no fabricated zero baseline. Even a complete observation returns `sendAdmission: "unavailable"`. | Cwd/session-path equality is not authenticated deployment/incarnation/read-only authority. Consent, role mapping and receiver-side atomic native-dialog admission remain W3 work. |

These internal, unwired helper-contract changes have no registered production
caller beyond their source tests. Strict end matching also refuses trailing
newlines in pane/nonce values. Unknown upstream session forms remain unsupported
rather than being guessed into a path identity.

## Files

- `packages/pi-pa/src/pi-extension/herdr-peer-exchange.ts`
- `packages/pi-pa/src/pi-extension/herdr-peer-admission.ts`
- `packages/pi-pa/src/__tests__/herdr-peer-exchange.test.ts`
- `packages/pi-pa/src/__tests__/herdr-protocol-conformance.test.ts`
- `packages/pi-pa/src/__tests__/pi-phase3.test.ts`
- [Updated integration notes](PAP-303-herdr-lifecycle.md)
- This checkpoint.

The broader Pi run exposed a pre-existing `12`-module assertion despite the earlier
P2 lifecycle addition making the actual trusted list `13`. The fixture now checks
13 and the explicit lifecycle module while retaining the exact unchanged
registered-tool list (no peer tool). No runtime module was added by W1.

## Validation

The adopted dirty baseline reproduced **12 pass / 2 fail / 0 skip** in the original
four focused suites. After hardening, those four suites passed **24/24**. Adding the
trusted-entrypoint regression suite produced **30 pass / 0 fail / 0 skip**:

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/herdr-lifecycle.test.ts \
  packages/pi-pa/src/__tests__/herdr-protocol-conformance.test.ts \
  packages/pi-pa/src/__tests__/herdr-peer-exchange.test.ts \
  packages/pi-pa/src/__tests__/pi-extension-composition.test.ts \
  packages/pi-pa/src/__tests__/pi-phase3.test.ts
```

Permanent cases cover request 4,095/4,096/4,097 encoded bytes; reply
16,383/16,384/16,385 bytes and 79/80/81 lines; mixed 1/2/3/4-byte characters;
independent whole-code-point tail measurements; both counter positions with
null/undefined/NaN/infinities/negative/fractional/unsafe/string/Boolean values;
unchanged/regressing counters; invalid states; unknown readiness/session facts;
nonce echoes and forged labels; and absence of terminal bodies on every outcome.

| Check actually executed | Result and limitation |
|---|---|
| `corepack pnpm typecheck` | Passed on the hardened helper source. |
| `corepack pnpm build` | Passed, including extension-source validation. |
| `corepack pnpm --filter @pa-platform/pi-pa typecheck` | Passed again after the trusted-entrypoint test correction, on the final code/test candidate. |
| `corepack pnpm completions` | Passed; generated tracked completions unchanged. |
| `corepack pnpm secrets:scan` | Passed with no staged entries; this is not evidence that the unstaged patch was scanned. No commit/staging was performed. |
| `git diff --check` | Passed. |
| Scoped current-file validation | Seven W1 files passed UTF-8/final-newline/no-NUL and the repository scanner's secret-like pattern checks without staging. Relative Markdown links/fences passed. This is a bounded pattern check, not a complete security review. |
| `corepack pnpm test` | **Failed**, exit 1. Root pretests 42/42 passed; pa-core: 2,294 pass / 1 fail / 14 skip. The conservative source-inventory check rejects `source-content-security.ts` against its recorded hash. That source equals retained HEAD and was not changed by W1. No automatic snapshot refresh was performed. Later workspace packages were not reached by this command. |
| `corepack pnpm --filter @pa-platform/pi-pa test` | **Incomplete**, tool timeout at 900 seconds. Its script tests passed 11/11. Before timeout, the source run exposed the stale 12-vs-13 module fixture above; the corrected fixture subsequently passed in the 30-case focused run. The full Pi run was not repeated or declared green. |
| `corepack pnpm --filter @pa-platform/opencode-pa test` | 109 pass / 0 fail / 1 skip (external configuration fixture unavailable). |
| `corepack pnpm --filter @pa-platform/runtime-host test` | 1 pass / 0 fail / 0 skip. |

The workspace inventory failure observed SHA-256
`7b5b9f36177d6e74c8493a617359e60b4035489d78b79609bd67465ad6573549`
for both the current and HEAD `packages/pa-core/src/source-content-security.ts`;
its manifest expects
`05dcccc36a059ae84a508f131c760112648777a2e246b79028c874e4ca2dbdfc`.
Semantic reconciliation belongs with W2's shared-policy review, not a blind
re-baseline to conceal a failure. Source-inventory completeness is not proven by
this first mismatch. The Pi timeout has no established root cause here.

The timed-out Pi command did not reach its final normal editor-bundle restoration;
the normal `bundle:extensions` command was explicitly run afterward. No test
process was left running at the subsequent process check. Tests use disposable
fixtures, not real Herdr peers. Tool output/log references are retained by this
session; no installed, hosted-CI, independent-review or genuine human pass is
inferred.

No human-facing CLI message or machine CLI/exit/stream contract changed in W1.
Changed reason/status values are internal unwired observation types, not new
public blockers. Human readability, CLI structural checks and installed message
propagation are not claimed from these software tests.

## Next allowed work

1. **W2:** characterize actual managed/standalone composition and source delivery,
   review the shared immutable-store policy widening, and semantically reconcile
   the conservative interaction inventory. A coverage string/late event is
   observability, not an unforgeable delivery boundary. Preserve original denied
   source reads; do not disable unrelated protections or read through a bypass.
2. **W3:** finish all six P1 contract items, especially protected agent-context
   reception/reply, authoritative roles/incarnations, atomic native-dialog
   arbitration, consent/revocation, durable pair reservation/deduplication,
   uncertainty/retention and total-deadline ownership. Obtain independent contract
   security review and Sinh's review of the new material interface before effects.
3. Only afterward scope dependent lifecycle/messaging implementation and separately
   current full source/installed/default-entry/foreground R1/R2, CI, NX and human
   qualification. Keep messaging unavailable if the protected boundary is not
   supported; lifecycle-only staging is not full PAP-303 acceptance.
