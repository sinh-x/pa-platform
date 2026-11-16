# PAP-303 — reconciled continuation handoff for d-b59414

Recorded: 2026-11-16, Asia/Ho_Chi_Minh (UTC+07:00). Prepared by `d-2d2cef` at
Sinh's request to document the changes needed for `d-b59414` to continue in the
ticket worktree. This is a documentation handoff, not a launch, runtime rebind,
installation, activation, native approval or product-acceptance record.

**Next objective: finish the effect-free helper hardening and produce the
feasibility-backed P1 safety contract. Keep peer messaging unwired. Investigate
source access/composition alongside that work; do not install first.**

## 1. Workspace and current checkpoint

- Repository: `pa-platform`.
- Ticket worktree: `/home/sinh/.treehouse/pa-platform-cdb114/15/pa-platform`.
- Branch: `feature/PAP-303-herdr-trusted-bridge`.
- Observed HEAD: `66629b6d2afdc44e3f9c346440f40791c3a9aeb5`.
- Pre-existing dirty file: `packages/pi-pa/src/pi-extension/herdr-peer-exchange.ts`.
- Its observed SHA-256: `b9a1f94d4f0383351bfb66130885dfa6a02f1d821754549e10a53442c1bfea36`.
- That uncommitted rewrite belongs to standalone Pi session
  `01a1e29d-562b-7562-ae39-293b58fbee01`; its tests/docs were not reconciled.
  Preserve it and review the diff before continuing. Do not reset or overwrite it
  merely to recover the earlier passing checkpoint.
- The canonical checkout remains clean on `develop` at `9489913`; do not implement
  there or silently retarget/rebase the ticket branch.

`d-b59414`'s registry currently records the canonical checkout, not this ticket
worktree. Establish the actual continuation's correct worktree/runtime binding
before edits; this document does not change a running deployment's binding. Read
this worktree's `AGENTS.md`. Confirm there is one active writer and no concurrent
standalone edit before adopting the unfinished change. Do not terminate or restart
another session as part of this handoff.

Suggested initial observations, not a substitute for runtime binding:

```sh
cd /home/sinh/.treehouse/pa-platform-cdb114/15/pa-platform
pwd
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short --branch
git diff -- packages/pi-pa/src/pi-extension/herdr-peer-exchange.ts
```

### Required context

- [Earlier follow-up plan](plan.md): retained historical proposal; the ordering
  corrections in this handoff supersede its install-first continuation sequence.
- [Independent monitor report](file:///home/sinh/Documents/ai-usage/deployments/d-b59414/PAP-303-independent-pi-monitor-report.md): original findings F1–F4 and historical 14/14 result.
- [Published r002 requirements](file:///home/sinh/Documents/ai-usage/agent-teams/requirements/artifacts/packages/PAP-303/pap303-herdr/r002/requirements.md), especially §§3–7, and
  [paired UAT](file:///home/sinh/Documents/ai-usage/agent-teams/requirements/artifacts/packages/PAP-303/pap303-herdr/r002/uat.md).
- [Integration notes](../../docs/PAP-303-herdr-lifecycle.md) and
  [source-denial investigation](../../docs/PAP-303-source-denial-root-cause.md).
  Their implementation/installed claims must be read at their historical scope;
  the full six-item P1 contract is not established by a lifecycle-only audit.

## 2. What changed since the monitor report

The original committed helper returned `correlated` from nonce presence plus a
completion-counter increase. The unfinished rewrite now returns `unverified`
with `unframed-channel`, allowlists `idle`/`done`, validates counters and truncates
at UTF-8 boundaries.

Checks actually executed by `d-2d2cef` against that dirty source:

| Check | Observed result | Limit |
| --- | --- | --- |
| Four focused Herdr/composition suites (§6) | 12 passed, 2 failed, 0 skipped; exit 1 | Both failing exchange tests still expect the old `correlated` result. Not a current green checkpoint. |
| In-memory echo + unrelated-completion probe | `unverified`, not `correlated` | Safer wording, not proven response attribution or an authorized reply channel. |
| Working/invalid status and invalid counters in both positions | Tested cases return `uncertain` | Not exhaustive protocol/schema qualification. |
| Long euro, emoji and mixed multibyte tails | 16,383/16,384/16,384 bytes; no introduced U+FFFD | Narrow probes; permanent boundary regressions still needed. |
| Minimal target `{ pane_id: "w1:p2", agent_status: "idle" }` | Still admitted, with null completion and fabricated zero state-change baseline | Monitor F4 remains open. |

No repository files were changed by those probes. Tests used disposable local
socket fixtures/fake reporters, not live Herdr peers. No full workspace,
installed, independent-security, CI or human acceptance pass is claimed here.

## 3. Changes to the earlier proposed sequence

1. **Do not make an AgentKit fix a universal first blocker.** Its interference
   was observed in the standalone session. First characterize the actual managed
   composition; do not infer it has the same plugin. Pure helper hardening can
   proceed independently of installed-source access.
2. **Do not install/version-bump before contract and security disposition.** Build
   an isolated candidate when authorized; use `docs/release-process.md` for later
   packaging/installation. `ppa --version` identifies a label, not proof that the
   registered guarded read route ran.
3. **Do not treat consent plus pane mapping as sufficient to wire messaging.**
   Protected agent-context reception, explicit response attribution and atomic
   native-dialog arbitration must first be demonstrated.
4. **Move contract/shared-policy review ahead of dependent effects.** Keep final
   implementation review, installed checks, CI and UAT as separately current
   evidence; do not defer all safety review until after live activation.
5. **Lifecycle-only staging is not full PAP-303 acceptance.** Any changed-scope
   staging decision must be explicit. Keep the original full messaging criteria
   visible rather than weakening them to match current helpers.

## 4. Immediate work packages

### W1 — finish effect-free helper hardening

Primary files:

- `packages/pi-pa/src/pi-extension/herdr-peer-exchange.ts`
- `packages/pi-pa/src/pi-extension/herdr-peer-admission.ts`
- `packages/pi-pa/src/__tests__/herdr-peer-exchange.test.ts`
- `packages/pi-pa/src/__tests__/herdr-protocol-conformance.test.ts`

Required changes:

- **Monitor F1:** preserve the refusal to claim correlation from terminal text.
  An echoed request and an unrelated turn must never complete an exchange.
  Stronger nonce spelling, a reply marker copied into a prompt, or a renamed
  success status does not solve transport/provenance. Do not expose unrelated
  terminal tails as peer replies, including on unverified/uncertain outcomes.
- **Monitor F2:** require supported settled states and nonnegative safe-integer
  counters with strict advancement. Test working/unknown/blocked/garbage states,
  null/undefined/NaN/infinite/negative/fractional/unsafe counters in both positions,
  and unchanged/regressing counters. Give invalid-state failures a truthful reason
  rather than implying only a framing problem. Settle is not request attribution.
- **Monitor F3:** retain code-point-safe truncation, check the final encoded byte
  count, and add permanent UTF-8/line boundary regressions. Exercise 16,383/16,384/
  16,385-byte and 79/80/81-line replies, including mixed 1/2/3/4-byte characters.
  Keep explicit partial/truncated status. Test exact request byte boundaries too;
  count the complete wire request, including its envelope/nonce.
- **Monitor F4:** missing readiness must not be admitted. Do not fabricate a zero
  state-change baseline. Either make this a clearly named preliminary observation
  filter with no send-admission claim, or require the complete fail-closed input.
  Null upstream counters remain unknown/unsupported unless the reviewed contract
  proves safe handling. A cwd or session-file path alone is not authenticated PA
  deployment identity, process incarnation or read-only authority.
- Update tests and integration notes to the chosen conservative result contract;
  do not merely replace old expected strings while leaving missing invariants
  untested. Keep all helpers unregistered as effects.

Exit: new negative regressions and focused suites pass on the exact candidate;
report what remains unavailable. Prefer a separate hardening commit after the
required checks. No request tool or live peer check is part of W1.

### W2 — source-access and composition investigation, parallel to W1

Owners/files: PA runtime and shared source-security owners;
`packages/pa-core/src/local-source-file.ts`,
`packages/pi-pa/src/pi-extension/{bound-local-read,local-content-security,source-guard-coverage,index}.ts`,
and the actual selected Pi host/extension composition. AgentKit configuration is
owned separately by its operator/plugin maintainer.

- Distinguish PA's hard-link admission from AgentKit path blocking and from reader
  replacement. Preserve the exact process/composition and original denials.
- Use a minimal inert harness for managed trusted-only and relevant standalone
  compositions. Establish reader replacement, hook order, final delivery and
  persistence behavior against admitted exact Pi API/source evidence.
- A `pa-local-read/v1` details string and an `agent_end` coverage event are
  observability, not an unforgeable final-delivery enforcement boundary. A late
  warning cannot undo earlier exposure. Preserve the current non-hostile-same-UID
  threat boundary; do not make a broader isolation claim.
- Require an enforced delivery boundary or refuse an unsupported composition;
  do not assume register-last alone solves every transform/direct/nested path.
- Independently review the general immutable-store route as a shared policy
  widening. Compare it with the existing finite selected-host route and a
  separately reviewed Herdr-source acquisition contract; do not silently accept
  all store text solely because it is immutable/world-readable.
- Reuse applicable PAP-298 selected-host/publication work without silently enabling
  that default-off host or treating its Pi-doc scope as Herdr-source permission.

This review's normal reads of the installed Pi README and `docs/extensions.md`
returned `LOCAL_SOURCE_UNSUPPORTED_FILE`. No alternate reader/copy/locator was
used. The source/runtime owner must establish admitted access; do not use this
handoff to bypass those denials. Installed hook/API compatibility remains open.

Exit: composition evidence, explicit policy disposition and an executable
source-security matrix, with unavailable evidence called out. An AgentKit repair
may run separately under its own owner; do not disable unrelated protections.

### W3 — complete the exact P1 contract before dependent effects

Produce a concrete contract artifact covering all six requirements §5 exit items:

1. Exact Pi/PPA/Herdr source/API/license hashes, privileges, NX selection and
   separately authorized standalone/managed loading evidence.
2. Evidence-backed composition choice and exact versioned package/config interface,
   defaults, opt-in/disabled behavior and responsible owners.
3. Proven agent-provenance submission **and reception/reply**, with one
   linearization boundary covering consent, all native dialogs, read-only target
   admission and both endpoints' live incarnations. Audit whether `agent.prompt`
   emulates terminal input; API existence is not this proof.
4. Finite schemas and concrete reservation, deduplication, uncertainty/recovery,
   cancellation, revocation, settlement/retention and monotonic-deadline owners.
5. Executable source/security matrix and exact installed/default-entry/foreground
   procedures, candidate/tool/environment pins and timing/cleanup tolerances.
6. Consumer/blast-radius analysis, independent contract security review and Sinh's
   review of the new material interface before dependent implementation.

**Preferred architecture to investigate, not an available API claim:** Herdr for
lifecycle/discovery, with a supported PA-aware native receiver/reply channel that
cannot be confused with terminal input or a human answer. Bind typed agent-context
requests/responses to request ID, both deployments and incarnations, and the live
consent/reservation. Preserve existing native approval/capability/custody owners.
If Pi/Herdr cannot support the atomic protected boundary, identify the required
upstream/runtime extension or leave messaging unavailable. Do not build an
unreviewed generic socket/file/terminal fallback to make the test pass.

Do not request the already-settled limits again: request <=4,096 UTF-8 bytes;
reply <=80 lines AND <=16,384 UTF-8 bytes; one exchange per unordered live pair;
60 seconds total admission/submission/wait/read budget; revocable exact-live-pair
consent ending on restart/rebind; zero automatic resend; no default bridge bodies;
unresolved original-owner tombstones until settlement; seven-day settled bridge
metadata retention. Existing Pi transcripts are not erased by bridge retention.

Exit: each P1 item is evidenced or explicitly blocked. A contract proposal is not
an approved contract. If protected transport is unproven, do not wire a request
effect merely because consent and pane mapping can be implemented.

## 5. Later implementation/qualification gates

### Lifecycle

After the applicable P1 review and explicit continuation scope:

- Check actual Pi event/context compatibility, rather than relying on fake-host
  tests alone. Integrate every native dialog and central disposal/reload lifetime.
- The current bridge listens for `herdr:blocked`; the inspected PA source contains
  no emitter. Do not claim complete dialog reporting from that listener alone.
- Cover truthful terminal/unknown states, identity/rebind/incarnation changes, two
  start/reload cycles and repeated shutdown; dispose bus listeners and owned
  resources without duplicates or registry reopening.
- `packages/pi-pa/runtime/selected-pi-environment.json` omits
  `PA_HERDR_LIFECYCLE`, `HERDR_ENV`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`.
  Review the actual selected-host forwarding/binding contract before changing it;
  adding names alone does not authenticate a pane or deployment.
- Distinguish static fixture conformance from comparison to the actual selected
  installed Herdr version/schema. Pin and verify that pairing separately.

Only then qualify an isolated candidate and one explicitly named foreground
lifecycle deployment. Keep defaults off and absent/non-Herdr binding inert.

### Messaging

Only after W3 proves the supported boundary and its material contract is reviewed:
implement revocable consent, authoritative deployment/role/incarnation binding,
receiver-side atomic dialog/read-only admission, durable unordered-pair reservation
and unresolved-intent deduplication. Preserve delivery knowledge separately from
wait outcome; ack loss, timeout, cancellation, crash/reconnect and late replies
must not permit automatic resend or new-ID escape. The 60-second limit applies to
the whole exchange, not a full fresh timeout for each stage. Only requester A
waits; read-only B replies without waiting back; R2 follows safe settlement.

PAPC may select supported capabilities/defaults; NX owns declarative package/env
wiring and rollout. Neither configuration can manufacture a protected receiver,
trustworthy correlation or native consent enforcement. Read-only inventory remains
with PAP-281/PAP-286, not this effect.

### Final evidence

Keep source checks, independent security review, hosted CI, installed/default-entry
pairing, actual authorized builder-A/read-only-B lifecycle/R1/R2, standalone/
disabled regressions and genuine Sinh UAT separate. Require current exact-candidate
evidence, not reused historical passes. NX handoff must identify the qualified
interface and remaining limitations. No ticket completion from lifecycle alone.

## 6. Validation and handback

The focused command below was actually run in the preceding review and produced
12 pass / 2 fail on the dirty checkpoint. Rerun after W1; it uses no live Herdr peer:

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/herdr-lifecycle.test.ts \
  packages/pi-pa/src/__tests__/herdr-protocol-conformance.test.ts \
  packages/pi-pa/src/__tests__/herdr-peer-exchange.test.ts \
  packages/pi-pa/src/__tests__/pi-extension-composition.test.ts
```

For code changes, finalize the affected validation matrix under P1 and follow the
repository checks: `corepack pnpm typecheck`, `corepack pnpm build`,
`corepack pnpm test`, `corepack pnpm completions`, and `git diff --check`.
Run `corepack pnpm secrets:scan` before a sensitive-workflow commit. Changes to the
shared source route require its source-security/reader/artifact regressions, not
only the four Herdr suites. Human-facing message changes must follow
`docs/cli-message-standard.md` §§4/8, with clarity, structural, software and
installed evidence distinguished.

Hand back separate hardening and contract/composition checkpoints where feasible:
exact branch/HEAD and retained dirty-state ownership; changed files; focused and
broader check outcomes; disposition of each monitor finding; each P1 item and its
evidence/blocker; and next allowed step. State explicitly that no installation,
activation or messaging occurred unless separately authorized and actually done.
Do not mark this documentation as a product check, independent approval or UAT.
