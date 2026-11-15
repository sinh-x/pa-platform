# PAP-299 native advanced-lineage continuation

Source continuation after `e8471c3`; **not completed implementation, new native
selection, independent review or PR/merge readiness**. The operator requested
finishing implementation before PR. No push/merge/installation, real ticket-link
refresh, native handoff execution or historical repair occurred.

## Actual owner changes

`documents/handoff-git.ts` now supports read-only reuse of an authenticated
advanced descendant, not only fresh compare-and-create:

1. Every NEW creation atomically saves its exact parsed original intent in
   `handoff_git_creation_sources` together with the existing durable operation
   binding/unpredictable correlation marker, before any Git write. Existing
   `handoff_git_intents` schema/bytes are not rewritten or backfilled.
2. Reuse names the **original completed creation operation**. Its stored intent
   must hash to the original Git binding and exactly match repository key/root/
   physical identity, ticket, branch and original integration base. A missing,
   corrupt, orphaned or foreign source fails closed. A matching SHA/name is not
   a replacement source; older source-less operations remain ineligible for
   reuse. Original same-operation fresh-create observation/recovery is retained.
3. The original creation reflog marker and complete branch-journal evidence must
   agree, and the original completed result must be the recorded integration
   base. An incomplete original ref/link operation cannot authorize reuse.
4. The actual tip must exactly match the newly reviewed intent's observed HEAD
   and descend from the original base. Reuse emits native lineage evidence and
   has **no create capability**: calling its Git port's create method rejects.
   It never writes a ref/reflog, resets history or acquires resources. Native
   Git observation also disables lazy fetching and terminal prompts, so missing
   promisor objects cannot silently invoke a remote helper.

`documents/handoff-native-branch.ts` now materializes the newly observed reusable
HEAD instead of forcing the initial base as HEAD. It additionally verifies that
this tip descends from the complete previously linked HEAD, so even a tip still
descending from the base cannot move materialized metadata backwards. Current
new-subject authority is required for remaining ticket writes; an already
completed original link may only be observed/settled after revocation.

`tickets/handoff-intent.ts` keeps the exact old materialized link during planning,
including attribution, original base and old HEAD. Native lineage/ancestry checks
are still required; structure is not provenance. The post-publication finite
materialization alone updates HEAD, and the pure TicketStore projection now also
rejects any HEAD other than the exact create-base/reuse-observation pin in its
native plan. No old package/scopes/intake validators or generic Git linkage owner
are repurposed.

## Actual checks

- Whole workspace `corepack pnpm typecheck` and `corepack pnpm build`: exit 0.
- Eleven focused suites: **117 passed, zero failures/skips**, including the
  previous reader-worker, retained document and catalogue coverage.
- Eighteen additional actual Git/TicketStore source tests cover: advanced reuse
  across intent/ticket/audit reply loss; moving develop without changing the
  original base; zero ref/reflog/checkout/lease/capacity effects; preserved staged
  binary/untracked work and link attribution; no create capability; revocation;
  missing/corrupt source, incomplete origin, moved tip, foreign marker/name;
  backwards metadata rejection; exact planned-HEAD enforcement; and actual child
  SIGKILL after advanced ticket persistence followed by only its missing audit
  and original-operation settlement. A separate inert promisor-helper baseline
  proves ordinary Git would invoke the helper, while native observation does not.
- The real process-death test observes SIGKILL, the already-written advanced
  link, missing audit, then exactly one original audit and unchanged ref/reflog.
  Other boundary faults are deliberate exceptions, not claimed process kills.
- `git diff --check`, workspace `corepack pnpm completions` and staged
  `corepack pnpm secrets:scan`: exit 0. Tracked completion bytes are unchanged.
  Logs: `/tmp/pap299-native-reuse-{typecheck,build,focused,completions,secrets}.log`.

These tests use actual source owners and disposable Git/SQLite/ticket stores,
with explicitly synthetic review/publication authority. They are not genuine
native review decisions, installed qualification or human UAT. The root creation
and lineage adapter's physical Git/durability assumptions still need independent
review and the requested competing-owner/power-loss qualification.

## First unproven integration step

Actual native ticketless association/intake and a distinct finite handoff-review
registry/foreground decision/publication consumer are still missing. The selected
profile/tool, packaged trusted browser/display/network/cleanup owner and complete
paired/full/retained/CI/installed/human validation remain unfinished. Neither
callback fixtures nor these internal, unregistered owners supply those routes.

The normal guarded read of the configured Pi 1.4.0 README was retried during this
phase and again returned `LOCAL_SOURCE_UNSUPPORTED_FILE`: qualified selected Pi
documentation eligibility was not established. No bytes were delivered, copied
or read through an alternative. Existing PAP-298 access-reconciliation request
`c-20261114230653395` remains the owner route; rebasing/building these sources does
not qualify or upgrade the running host. Pi SDK/native foreground changes must
wait for permitted selected documentation and actual API/selection review.

No new human-facing CLI wording, error code, stream/exit contract or approval
receipt is introduced. Existing failure categories and original-operation
semantics are reused. Human readability/browser/accessibility review is not
asserted; earlier aggregate/source-pair/retained/installed failures are not waived.
