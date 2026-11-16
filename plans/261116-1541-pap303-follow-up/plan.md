# PAP-303 follow-up plan

Date: 2026-11-16 15:41 (+07). Branch `feature/PAP-303-herdr-trusted-bridge`
(develop `9489913` v0.1.170 merged at `9650da5`; head `ad001b7`). Deployment
`d-4b9ba1` still runs the installed 0.1.170 build, not this branch.

## Status snapshot

Implemented and source-tested on the branch:

- Ordinary reads admit exact immutable `/nix/store` text (root-owned, non-writable,
  stable, text-only); hard links outside the store, symlink spellings and mutable
  files stay denied (`d307bf1`).
- `LOCAL_SOURCE_UNSUPPORTED_FILE` states the real supported shapes (`6350e1d`).
- Guarded reads carry `pa-local-read/v1`; `agent_end` records one bounded
  activity event when a read result came from another implementation (`02b7f62`).
- Herdr lifecycle bridge, default off: `PA_HERDR_LIFECYCLE=1` plus a validated
  same-user unix socket, bounded payloads, latest-wins queue, no tool/prompt
  surface (`815c870`).
- Herdr protocol-22 conformance fixture/test and the pure peer-admission
  predicate (`a94529f`); pure request-planning/reply-attribution helpers
  (`a6293ee`). P3 remains unwired.
- Docs: root cause (`b52384c`), Herdr audit/P3 correction (`c9b7e00`, `0169abe`,
  `ad001b7`); earlier audit marked superseded (`1ecdfa6`).

Last checks: workspace typecheck PASS; focused pa-core/pi-pa suites 14/14 PASS;
pi-pa package compile with extension-source validation PASS.

## Issue ledger → follow-ups

| Issue | State now | Follow-up | Owner | Acceptance (exact) | Evidence lane |
| --- | --- | --- | --- | --- | --- |
| PA denied multi-link store text (Pi docs, Herdr source) | fixed in branch, uninstalled | F1 install candidate | PA runtime | installed `ppa --version` exercises the new route; store text read, symlink spelling denied | installed observation |
| Denial message conflated link policy with selected-Pi eligibility | fixed in branch | covered by F1 | PA runtime | installed denial text names the link/store shapes | installed observation |
| AgentKit `scout-block` blocks `node_modules`/`dist`/`.git` and points at a nonexistent `.ckignore` | unchanged, not PA-owned | F0 operator/AgentKit fix | AgentKit + operator | `read` returns Pi 1.4.0 docs; block text references an existing config | live read + hook log |
| PA's guarded reader is pre-empted in `d-4b9ba1`; precedence is Pi-owned | detectable, not prevented | F1a precedence investigation | PA runtime + Pi composition | documented load-order rule; harness shows which guard wins; attestation fires on the foreign case | source test + live |
| Herdr lifecycle absent in managed composition | bridge added, default off | F2 enable + live verify | PA runtime + operator | live pane shows working/idle/blocked; shutdown closes; no state duplication; absent binding is inert | installed + live pane |
| P3 submission exists but lacks consent, request-specific correlation, pane→deployment binding | helpers ready, unwired | F3 consent-scoped request effect | PA runtime (needs Sinh scope approval) | ticket guard list satisfied: self/stale/ambiguous/busy/blocked/dialog rejection, one in-flight, bounded budgets, uncertain-no-resend, revocable pair consent | source matrix + live A→B round trip |
| P4 qualification, review, CI, UAT unrun | not started | F4 evidence gates | PA runtime + independent reviewer | independent security review, hosted CI, 8 UAT scenarios, NX-069 pin | separate lanes |
| Branch not proposed for merge | 11 commits ahead of develop | F5 PR hygiene | PA runtime | PR to `develop`, phase table updated, no force-push | Git |

Boundary: read-only peer/session inventory stays with PAP-281/PAP-286; do not add
it here.

## Ordered sequence

1. **F0 (blocking, external).** Operator or AgentKit owner corrects the
   `scout-block` baseline/override for read-only source paths and fixes the
   error message's config path. Without this, Pi's own docs remain unreadable
   through `read`/`bash` even after F1.
2. **F1a.** Determine Pi 1.4.0 extension/hook precedence for a replacement
   `read`/`bash` tool: minimal harness with the trusted extension plus a hook
   plugin; record whether the hook short-circuits, replaces or passes through.
   Decide PA's response (register-last, startup self-check, or documented
   limitation) before claiming installed source-policy enforcement.
3. **F1.** Build and install a candidate containing the source repair. Version
   bump and Nix hash refresh follow `docs/release-process.md`; do not bump until
   F1a's precedence answer is known, so the installed claim is meaningful.
4. **F2.** Enable `PA_HERDR_LIFECYCLE=1` for one named deployment, verify live
   state transitions and shutdown, and confirm the absent-binding path stays
   inert. Keep default off elsewhere.
5. **F3 (requires explicit scope approval).** Implement the consent owner and the
   pane→deployment binding, then wire admission + planning + classification into
   one request effect with one in-flight pair, revocation on restart/rebind and
   no automatic resend.
6. **F4.** Independent security review of (a) the store-text route and (b) the
   lifecycle/peer contract; hosted CI; the eight UAT scenarios; NX-069 wiring.
7. **F5.** Open the PR to `develop` with the phase table and evidence links.

## Validation matrix per follow-up

| Follow-up | Must run | Must not claim |
| --- | --- | --- |
| F0 | read Pi docs; inspect hook log | PA fixed the plugin |
| F1a | minimal composition harness; attestation on/off cases | full policy enforcement |
| F1 | typecheck, build, focused suites, installed probe, live read | review/CI/UAT |
| F2 | live pane states, shutdown, inert-binding test | peer messaging |
| F3 | negative matrix, consent revocation, uncertain path, live round trip | general peer authority |
| F4/F5 | review record, CI run, UAT results, PR checks | product acceptance before UAT |

## Risks

- The store-text route is a policy widening; it needs F4's independent review
  before merge, even though it only admits world-readable immutable text.
- Enabling lifecycle reporting without F1a could produce "verified" claims from a
  session whose read guard is foreign; the attestation event is the guard against
  that, not proof of enforcement.
- F3 adds an effect surface (prompt submission to another pane). Without consent
  and binding it must stay unwired.

## Decisions needed from Sinh

1. Approve or defer F3's consent-scoped request effect in PAP-303.
2. Name the deployment that may enable `PA_HERDR_LIFECYCLE` after F2 checks.
3. Assign F0: AgentKit kit owner or local operator override.
4. Choose whether F1 bumps the version and refreshes the Nix hash now or only
   after F1a.
