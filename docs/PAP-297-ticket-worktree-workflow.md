# Existing ticket-worktree recovery workflow (PAP-297, source only)

This increment supports **linked-HEAD metadata refresh and retained execution
inspection**, not execution-claim settlement. It is not installed qualification,
MVM-245 recovery, builder admission or product acceptance. No checkout allocation,
lease return, process killing, Git/source edits or deployment launch is performed
by these routes. OPA/CPA and retained native tool grammars are unchanged.

## Inspect before changing anything

Run from the repository's exact registered **canonical root**, not its linked
checkout. First verify this candidate's interface is available:

```sh
ppa pi ticket-worktree --help
```

Then select exactly one existing ticket/lease. For the two reported preparation
cases, the source grammar is:

```sh
# From /home/sinh/git-repos/sinh-x/tools/pa-platform
ppa pi ticket-worktree inspect --repo pa-platform --ticket PAP-297 --json

# From /home/sinh/git-repos/andafin/active/andafit-movement
ppa pi ticket-worktree inspect --repo work-andafit-movement --ticket MVM-245 --json
```

These examples were not executed against those live records in this session.
Older installations may not provide this interface; installation/adoption needs
its own authority. Do not use a raw-state edit as a substitute.

The result separates `head`, `execution` and `capacity`. `observed` means only that
HEAD matches and no claim for this checkout/slot for this ticket was observed;
repository-wide capacity and launch admission were **not** checked. Other tickets
are not swept. `blocked` and `unavailable` never grant recovery authority.

The preparation deployments d-c1eccf and d-66733d are context, not necessarily the
owners of retained execution claims. The workflow discovers the actual predecessor
from protected checkout/slot records rather than accepting a caller's guess. For
MVM-245 the historical blocker is d-8860e8; current records must still authenticate.

## Refresh only a descended linked HEAD

If `head=refreshable`, inspection emits an exact `refreshCommand`. Review and
explicitly authorize that metadata-only command before running it. Its grammar is:

```text
ppa pi ticket-worktree refresh-head --repo KEY --ticket TICKET --expected-observation SHA256 [--json]
```

Use the complete command from the exact preview, not a fabricated digest. The
operation reobserves ticket bytes, physical registration identities, branch/base/
HEAD, status, lease and protected target claims inside the existing capacity and
ticket-owner exclusion. The ticket owner compares both the predecessor and its
own resolved Git target **before** writing ticket/audit bytes. Rewinds, replacements,
changed previews, sibling claims and unsupported prepared capacity do not silently
refresh. Redirecting `GIT_*` environment variables also refuse this write route.

Only the existing ticket link/audit and ordinary coordination files may change.
Immutable base, source/index/refs, dirty files, ownership, operation barriers and
slot/permit remain untouched. A successful refresh is **not** a successful execution
recovery. Reinspect afterward. Replaying the old preview does not append another
refresh; it blocks. A lost/uncertain reply requires inspection of the same ticket
and existing audit, not a fresh execution or deletion of evidence.

## Diagnose retained execution separately

When claims exist, `inspectionCommand` names the supported read-only exact-owner
route, `ppa pi inspect-recovery --repo KEY --ticket TICKET --deployment-id ID`.
`recoveryCause` is a bounded summary, not an eligibility grant. Refresh a valid
stale HEAD first if it prevents complete checkout correlation, then reinspect.

Neither CLI route provides execution apply or automatic launch recovery in this
increment. Historical process-group tracking cannot prove that escaped descendants
are quiescent. d-8860e8's unknown cleanup cannot be upgraded merely because its PID
is gone, Treehouse reports no processes, or an operator confirms a prompt. Keep
claims and the same dirty checkout until their native owner supplies sufficient
proof and supported locked settlement. Do not force takeover or return the lease.

After real supported settlement (future work), reauthenticate the same checkout,
lease/files and permit inventory, then run canonical-CWD ticket-worktree selection
and a separately supported non-spawning builder-admission probe. A selection
`--dry-run` alone is not capacity-admission proof.

## Contracts and limits

- Inspect performs no TicketStore initialization, mutex creation, registry migration,
  evidence publication, allocation or recovery. Refresh uses the existing native
  ticket writer/audit owner; it is not a second unlock ledger.
- JSON schema: `pa-ticket-worktree-recovery/v1`. JSON is stdout-only, one object;
  usage errors use stderr. Exits: 0 observed/head-refreshed, 1 blocked, 2 unavailable/
  uncertain/invalid grammar. Original inspect-recovery contracts remain unchanged.
- Flags are exact and bounded. No paths, force/apply, actor, token, dead-process or
  imported-outcome overrides are accepted. Public output omits protected tokens,
  process births, commands/private output and dirty file contents.
- Ticket evidence is bounded to 1 MiB; registration and target capacity records to
  64 KiB. Git subprocesses use 15 seconds/16 MiB; Treehouse keeps 15 seconds/1 MiB;
  native evidence/process enumeration keeps the prior finite inspection bounds.
  Existing capacity/ticket mutex waits are five seconds each. This is not a globally
  cancellable transaction or a complete byte-level dirty inventory.
- Human blockers contain one five-field envelope under 2,000 UTF-16 units. New
  command-bearing envelopes use finite static prose and re-derived bounded commands
  rather than the shared weighted truncator, which can truncate command digests or
  required action metadata. This exception is covered by worst-grammar tests.

See [progress and actual checks](PAP-297-recovery-progress.md). Full claim recovery,
normal-finalization reuse, automatic real-launch integration, independent review,
installed verification and genuine human UAT remain outstanding.
