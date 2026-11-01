# PAP-273 phase 2 — committed compatibility and retained resources

Source implementation only. Not installed policy, a completed ticket, native
requirements/UAT approval or acceptance. The preceding phase-1 record is
`docs/workflow-startup-compatibility.md` at commit `ee0a1ca`; its pin-equality
statements describe that earlier increment, not this phase's replacement reader.

## Compatibility contract

There is no additional user-maintained compatibility manifest, second template
registry, selection authority or approval ledger.

`CommittedConfigSource` authenticates the configured physical root and exact teams
root, selected commit, tree chain and blob identities, and each consumed working
file against that commit. It recomputes Git object IDs and retains SHA-256 resource
identities. Safe bounded Git reads disable replacements, hooks, monitors, ambient
Git configuration, optional locks and network/lazy fetch. Aliases, hard links,
untracked/dirty substitutions, unsupported modes and mid-observation selection or
byte drift fail closed. Only verified immutable tree/blob data is cached; never
selection, working bytes, compatibility, permissions or results.

`selectedTemplates()` derives the registry identity from this committed selection.
The existing closed template/workflow schemas and real consumers remain the
compatibility contract. A compatible new config commit or registry revision needs
no runtime rebuild merely to change the whole-config HEAD. Unsupported contracts,
missing consumers, incorrect digests and uncommitted overlays still reject. No
current-latest or old-pin fallback is attempted.

`.pa-platform-config.sha`, `.pa-template-registry.sha` and provenance `configSha`
remain **package build provenance**. Qualification verifies those baseline pins
against the exact candidate/installed package separately from the current selected
config/registry identity. Source SHA, module bytes and selected committed resources
must still match their actual identities. Legacy prepared-native activation keeps
its separate exact-runtime/config qualification gate; phase 2 does not upgrade
legacy grants or imply that every execution route is ready.

Limits: 1 MiB per object/resource, 256 retained resource/absent-reference paths,
16 MiB total resource bytes, bounded object caches and 16 path components.
Existing public request, transport and native decision-view bounds remain; there
is no truncation or caller-supplied passed flag.

## Existing journal, new per-run evidence

New native produced admissions register `captureWorkflowResources`. The existing
`workflow_snapshots` store retains the exact raw registry/templates, workflow
manifest/definitions and applicable team/objective/instruction/skill/project-guide
closure. The admitted event contains `resourcesSha256`; no new database or grant
ledger is created.

The internal closed manifest is `pa-workflow-resources/v1`:

- Physical config root, exact config revision, repository key, workflow SHA-256
  and registry SHA-256.
- Exact caller/target routes, plus requirements/review-auto when check.matrix
  requires that actual consumer.
- Resource paths/raw SHA-256 values and authenticated absent prose references.

Declared team/instruction dependencies and explicit local Markdown links are
required. Inert bare-path prose examples may refer to runtime companion documents
rather than config files. Their committed absence is retained explicitly in
`absentReferences`, not repaired by adding a PA application dependency, reading an
untracked file, silently importing another repo or adopting future selected bytes.
Live bulletins, permissions, revocation, custody and native effect checks are not
frozen by snapshots.

The native package decision view includes the exact resource manifest. Its
capture evidence and immutable run identity bind the displayed subject and
resource identities. Revised subjects remain in the original run/resource closure;
there is no resource-migration endpoint or reuse of approvals for changed bytes.

## Continuation and consumer interfaces

- `retainedTemplateHost` and `retainedWorkflowSelection` reuse the actual existing
  registry/definition parsers against original journal bytes.
- Pi template CLI/native tools automatically use retained resources in an active
  ticket read context. These are unsigned observations, not effect authority.
  Public JSON accepts no run/resource/path/hash override.
- `pinnedPiWorkflowConfig` reads the actual ticket/journal before planning, selects
  its retained team, and checks unchanged subject/resource identity again before
  launch. Protected review's incompatible-authority gate still precedes retained
  lookups and allocation.
- The deployment owner projects exact journal bytes into
  `<deployment-dir>/pinned-workflow-config`: private directories, read-only files,
  digest checks, no alias/hard-link adoption and no overwrite on conflict. This is
  disposable presentation data, never another source of authority. Planner skill
  paths, primer instructions and reference pointers use this projection.
- Physical selection namespace, exact subjects/decisions, task command compatibility,
  approved checks, custody, trusted executables and confinement remain enforced
  at their real boundaries. New source/check requests do not follow from a
  successful template observation or queued ticket.

Legacy runs without the original closure remain readable and revocable. New
capture/revision/effects/planning cannot import current resources to fill the gap.
They report `resourceState: legacy-missing` / `retained-resource-closure`. Existing
same-intent proven effects may settle without inventing a new dispatch or resource
migration; unknown results remain unknown.

## Verification and unperformed gates

Phase-2 checks include committed compatible revision changes without package-pin
edits; dirty/self-consistent substitutions, root/team/alias drift, hooks/config
injection, unsupported schemas/operations; immutable snapshots and retained
absence; changed current instructions/templates; native default-host selection;
legacy refusal/revocation/proven settlement; and read-only projection tampering.

The built public PPA CLI/default native template fixture passed across compatible
config revisions with the same package baseline pins (all sixteen canonical
producer families). This is a disposable source-built check, not installed or
human qualification. All 16 native workflow cases remain mandatory. Installed
workflow accounting now has 21 rows, including new compatibility/retention anchors;
no prior required case was dropped.

The broad source code-only run completed, not timed out: core 1,519 passed / 14
existing optional skips, OpenCode 104 passed / one skip, Pi 1,041 passed / five
existing optional skips / **one failure**. The failure exposed protected review's
legacy-authority gate being preceded by the new lookup. Ordering was corrected;
the focused complete review-preflight + retained-host suite passed 35/35. The
entire broad run was not rerun after that correction: it is not a green-CI claim.
Final source checks passed: typecheck, build, unchanged completions, 216 affected
regressions, 25 script regressions, and 36 full native-workflow/built-CLI tests,
with zero skips in those focused entries. Exact commands are retained in the
deployment handoff.

Actual selected config c614cfd source-built observations: template list returns
17 entries; PAP-273 preflight is static-compatible with `projectProfile: missing`
and a separate execution blocker; read-only full resource closure observes 90
resources plus six absent runtime-companion prose references. No package admission
or human approval follows from those observations. The installed host was not
changed or reloaded and remains a separate qualification gate.

## Next deployment / PAPC-073

Stop after this phase. PAP-273 remains pending implementation, not done. Continue
with phase 3: versioned repo-local catalogue semantics, bounded ticketless setup
admission/writer and coordination with PAPC-073. Then phase 4 owns operator-only
password approval, rotation/reset/revocation, hash evidence and local Git-exclude
reconciliation. Those CLI/credential/setup interfaces are **not implemented yet**;
PAPC-073 must not infer them from this resource contract or activate guidance as a
permission grant.

Remaining separate gates: complete local/hosted tests, independently reviewed
exact Git/package provenance, authorized build/install/selection/reload, paired
installed/fresh-host qualification, independent matrix/review, genuine human
UAT/adoption and history-preserving affected-ticket continuation. No push, install,
config/pin edits, application/device operation, phase-3 work or checkout return is
part of this handoff. Preserve PAP-271/PAPC-072 history and existing live custody.
