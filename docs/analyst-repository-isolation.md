# Analyst execution and independent ticket administration

## Status and scope

PAP-334 currently delivers independent typed ticket administration and an interim
fail-closed launch check. **It does not deliver a usable confined Analyst executor.**
The complete ticket is not accepted. In particular, stopping a launch does not
satisfy ordinary shared-file access, the eight-stage foreground journey, or the
forced-effect isolation matrix. Source support is not installed availability.

The required move guarantee remains literal: a denied cross-boundary move must
preserve both relevant sides through every enabled channel, including arbitrary
shell `mv`. It has not been narrowed to a typed move operation.

## Ownership and the PAPC contract

PAPC owns conversation policy, the eight stages, report quality, and genuine human
approach/final-content decisions. The companion sources are
`pa-platform-config/docs/workflow/requirements-design.md`,
`docs/workflow/analyst-report-quality.md`, and
`docs/workflow/examples/analyst-boundary-qualification.md` in that repository.
Those documents are not technical confinement or an execution grant.

PAP owns generic execution admission, filesystem/process infrastructure, typed
ticket persistence, authentication, audit and original-operation reconciliation.
This change adds no PAPC selector, approval engine, ticket-selection ceremony or
new implementation launch right. PAP-329 and PAP-331 retain their separate scopes.

The existing native launch event and primer retain actual `--ticket` provenance.
The requested administrative target is independent of that launch association.
Creating or inspecting another ticket does not replace the primary ticket,
allocate a checkout, or authorize source, branch, workflow or approval effects.
Ticketless creation remains possible through the typed administration owner.

The PAPC-107 handoff identified source `2ee48f899ae9b6fbf98bb7c083ed1fa0691a416f`.
The companion repository advanced during this implementation; a later observed
HEAD was `7c83e6ebb7730daaeca19220d65196e0f8b4e1f0`. This observation is not automatic
pair selection or qualification. Re-establish the exact committed config/runtime
pair through its owners before any future installed or foreground qualification.

## Interim execution behavior

The following existing selections require isolation and currently cannot start:

- Public `analyst`, in every mode.
- Historical `requirements/analyze`.
- The existing `pa-readonly-document/v1` profile, regardless of public team name.
- Retained protected v1/v2/v3 bindings and document-protocol evidence, including
  protected ancestors beneath a subsequently writer-labelled resume.

The reviewed ingress paths are the shared deploy CLI, Pi/OpenCode direct
launchers and adapters, raw background runners, and Agent API session startup.
API admission precedes runtime preflight and repeats before session allocation,
lifecycle logging or fallback-command execution. Raw runners check inside their
existing lifecycle before configuration consumption, ownership transfer or child
execution; rejected configurations and unsettled original claims are retained.

Original environments, their effective merge, immutable plans, plan environments,
all supported binding identities and retained native ancestry remain restrictive.
Changing a public selector, including to Rogue-one, does not clear protected
resume evidence. There is no force, approval, configuration or environment grant
that establishes confinement.

A direct adapter resume must bind its token and runtime to the original native
deployment and private recorded session. Native ancestry is inspected in one
existing-files-only read transaction. Missing starts, missing ancestors, cycles,
conflicting identities, malformed bindings and unsafe session files fail closed.
Read-only inspection must not create a registry or missing WAL/SHM sidecars.

Pi `spawn` consumes a fresh ID issued by that adapter exactly once. Supplying an
existing token is not fresh execution. This in-memory source reservation is not
qualification of races in installed Pi session storage. API stdout token hints
are observations, not resume authority. Unknown opaque API resumes remain
unavailable; proven launch-bound and recorded unprotected continuations retain
matching native provenance and the existing admission checks.

Source dry-runs may still produce private planning artifacts without an executor.
They are not pure reads, readiness, confinement or adoption. Calling an actual
adapter with its `dry-run` mode does not bypass execution admission.

Independently admitted non-Analyst writers retain their existing launch and
custody paths. No global chmod, chown, remount or Git-configuration change is
performed. Existing running sessions are not upgraded, terminated or reconciled
by a new rejection. Bare runtimes and independently controlled host actors do not
become confined through this source change.

## Independent typed ticket administration

Generic CLI/REST status administration no longer rejects a valid authenticated
caller solely for Analyst, a read-only profile, or Builder/implement spelling.
Existing validation, authentication, serialization, audit and native pending-effect
fences remain. Deletion is a separate operation and its restrictions are retained.
Existing creation and non-status API authentication policy is unchanged; this
change does not assert that every historical API operation has identical checks.

The Pi-native `pa_ticket` interface adds these bounded source operations:

| Operation | Contract |
| --- | --- |
| `inspect(project,id)` | Read complete snapshot/version and bounded ticket metadata. |
| `create(project,requestId,fields)` | Create an idea through the existing creation-intent owner; replay the original identity/content. |
| `update(project,id,expectedVersion,fields)` | Compare the complete snapshot and update only supplied administrative fields under the ticket mutex. |
| `set-status(project,id,requestId,expectedVersion,status)` | Use the existing durable status-intent/CAS owner and original-operation reconciliation. |
| `comment(project,id,content)` | Derive attribution from the authenticated native caller. |

The original `read`, `show` and `list` forms remain. The legacy comment grammar is
accepted by an authenticated compatibility adapter; supplied attribution cannot
impersonate another principal. Administrative fields are title, summary,
description, priority, estimate, type, assignee, tags, blockers, from and to.
Status is a separate intent operation. Source/Git evidence, raw replacement
records and caller privilege/identity fields are not accepted. The default
assignee is validated `sinh`, not an invented agent based on mode spelling.

These are source interface descriptions, not calls supported by an arbitrary
installed extension. The composed runtime must retain native session/process,
source-content and bounded-output owners. A standalone service export is not a
raw-store fallback or a private-data read grant.

Native creation/status reuse existing durable intents. Field-update reply loss
requires inspection of the original ticket; an unchanged request ID does not
supply field-update replay authority. Authentication, current sensitivity policy
and exact candidates are rechecked at the effect boundary. Text is checked both
before and after sanitization. Invalid native requests are rejected before
writable ticket initialization, with locked semantic rechecks before effects.

Retained workflow history or stage alone does not prohibit generic maintenance.
The native administration service and generic status path still fence mutations
against live or uncertain competing custody and incomplete native operations.
Unchanged CLI metadata semantics are not represented as native CAS or universal
pending-owner coverage. Native publication/queue owners use their own authenticated
exact intent, rather than being mistaken for unrelated generic administration.
Ticket maintenance never supplies publication, queue, acceptance or execution authority.

The dedicated `pa_ticket_status` port remains profile-selected but accepts exact
registered cross-project targets. `pa_ticket_intake` retains its finite profile,
planning and association contract. Neither is silently represented as a universal
administration API. Universal AC5 availability across every retained interface
and installed mode remains unqualified; use the generic typed owner where it is
actually supported, not a raw-store or alternate-writer workaround.

## Why read-only mounts were rejected as the complete mechanism

The disposable P1 probe demonstrated three counterexamples to a layout with
read-only repository mounts and a directly writable shared-directory bind:

1. A writable hard-link alias changed the protected repository inode.
2. GNU `mv` overwrote an ordinary destination, then failed to remove its protected
   source. A nonzero exit did not preserve both sides.
3. A pathname Unix socket reached a host service which wrote outside the namespace.

A direct write was rejected and an ordinary shared-file positive succeeded in
the same fixture. These are intended-cause mechanism counterexamples, not an
installed security advisory or proof that a replacement mechanism works.

## Remaining implementation and qualification

A usable executor still needs technically enforced transactional shared-file
semantics, complete registry/worktree/Git-storage topology, alias and inherited
handle coverage, host-effect mediation, drift invalidation and child settlement.
Neither a startup scan nor an after-the-fact watcher closes an effect-time race.
Do not roll an old snapshot over independently authorized concurrent changes.

Every enabled tool, interpreter, descendant and host delegate must be covered or
explicitly unavailable before qualification. Ordinary default/alternate-root,
cross-project and cross-deployment shared-file positives must accompany protected
negatives. Nested registered repositories remain protected. Resume, cancellation,
cleanup and uncertainty need their own evidence; a launcher rejection cannot
replace those tests.

See the companion qualification playbook for the full retained requirements.
Independent exact-candidate review, installed/config provenance, foreground
behavior, browser observation and genuine human UAT are separate evidence classes.
Installation/adoption requires separate authorization and has not been performed.
