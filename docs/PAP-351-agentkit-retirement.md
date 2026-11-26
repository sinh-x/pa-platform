# AgentKit hook retirement and manual host migration

PAP-351 keeps normal Pi extension discovery. PA does not load or require AgentKit
in the maintained runtime inputs checked by the repository regression. The known
remaining selectors observed during implementation were installed **outside this
repository**, under the operator's Pi profile. A source change cannot unload an
extension already held by a process or repair an external installer.

This is a maintained operator runbook, not evidence that a host was migrated,
independent review passed, or human acceptance occurred. Historical records and
archived vendor originals are not active dependencies and must remain intact.

## Repository boundary

`packages/pi-pa/scripts/agentkit-retirement.test.mjs` runs in the existing Pi
script-test glob. It checks known retired identifiers in maintained launch,
packaging and dependency inputs, including repository-local Pi settings and
extensions when present. Seeded cases cover explicit extension arguments,
package/config selection, discovered extension paths, evaluator/child-script
references, packaging, CI and installer scripts. Archived docs, test fixtures,
vendored originals and generated outputs are not treated as maintained selectors.

Run the focused regression from the ticket worktree:

```sh
node --test packages/pi-pa/scripts/agentkit-retirement.test.mjs
```

This is a bounded source-name recurrence check, not a semantic loader analysis,
host scanner, startup refusal or runtime blacklist. Renamed/dynamically assembled
references, effective installed packages, external profiles, ancestor-project
configuration and generated output require their own inventory and observation.
Do not delete history or weaken guards to satisfy the test. If a new maintained
selection surface is added, extend the inventory and seed a recurrence there.

No launcher flags, extension defaults, skill defaults or PA policy rules change.
Protected review/validation restrictions retain their existing owners. PA's
policy asset remains module-relative; see [local-source content security](local-source-content-security.md).

## Manual work outside this repository — Sinh / host owner

Do not perform these steps while this implementation session or any other
process still holds the affected extensions. The following sequence is deliberate:
quiesce, reconcile, retire selections, then start a new process.

### 1. Attribute effective inputs before editing

For every supported standalone Pi/PPA profile and project, record:

- Actual executable/package identity, working directory and selected agent
  directory, including any custom `PI_CODING_AGENT_DIR`.
- User/project and ancestor-project extension directories, settings extension
  entries, configured packages and package manifests, explicit launch arguments,
  maintained profile/installer sources, wrappers and child-agent invocations.
- Loaded extension identities and registration/context/child observations from
  the actual process, not merely `pi list` or a source-string search.

At the 2026-11-26 implementation inventory, the operator profile contained:

| Observed path | Responsibility | Required disposition |
| --- | --- | --- |
| `~/.pi/agent/extensions/agentkit-hooks-engineer/` | Hook bridge, `hooks.json`, evaluator/child scripts and `security-sentinel.cjs` | Retire the whole active registration after verified quiescence; do not just remove a required child. |
| `~/.pi/agent/extensions/agentkit-agent/` | Registers the Agent tool and starts children with ambient discovery | Retire the active runner registration with the bridge; otherwise child discovery remains a route to hooks. |
| `~/.pi/agent/settings.json` | User packages and explicit resources | The observed package list did not name AgentKit. Reinspect current bytes; that absence does not remove discovered directories. |

These regular installed directories were not proven to originate in a particular
maintained repository. The bridge's install manifest named engineer 0.2.0, but
that is not canonical producer attribution. Trace the installer/profile owner
before changing its maintained source; otherwise regeneration may restore hooks.
A newly encountered/unattributed selector is a blocker on that edit, not permission
to guess its producer or disable all extensions.

### 2. Quiesce processes and preserve uncertain work

1. Identify the parent and child processes and their original deployment/session
   owners, including background runners. Preserve session/transcript identities.
2. Let admitted work settle or arrange owner-led cancellation. Reconcile uncertain
   tool effects against the original operation before any replay. A withheld reply
   does not establish that a shell command or write never happened.
3. Preserve original reports and their last verified bytes. Only an original active
   report owner may reconcile the same path. Ended reports, including the historical
   affected deployment, are not writable recovery targets for a new session.
4. Verify exit of all affected processes and children before changing their roots.
   If ownership, effect or exit is unknown, stop this migration and ask that owner.

Finish and exit this implementation session before retiring its loaded hooks.
Deleting/moving files or using an in-process reload is not proof that retained
hooks were unloaded. Do not remove PA guards to make an old process usable.

### 3. Retire attributed selectors and mandatory dependencies

After verified exit, remove AgentKit registrations from their **owning maintained
sources**, then reconcile generated user/project/package/explicit selections.
Preserve nonsecret configuration identities and before/after diffs. Resolve drift
or an existing backup collision before continuing; do not overwrite another record.

For the two observed installed directories, the host owner can preserve each
whole directory in a no-clobber archive **outside every selected extension,
package and explicit-resource discovery path**, then remove its active selection.
Do not leave renamed copies beneath `extensions/`: directory discovery may still
load them. Do not leave an explicit settings/package reference pointing to the
archive. Do not delete only `privacy-block.cjs`, `hooks.json` or the sentinel while
the bridge remains selected; it intentionally fails closed when dependencies fail.
Do not mutate a shared package root still needed by another process or runtime.

Preserve unrelated registrations such as Herdr, footer, web and image extensions,
and supported skill/content files. Broad AgentKit skill/content retirement,
shared `.agentkit` state deletion and historical transcript cleanup are not part
of this ticket. Removing the AgentKit runner may remove its `Agent` tool; it does
not authorize a replacement runner or enabling omitted tools.

### 4. Start a new process; resume only if eligible

Use the normal admitted launch route and the reconciled profile, retaining PA
policy and ordinary discovery. An eligible resume must create a new runtime
process over the retained history, not continue the old loaded process. Recheck
normal session/host/mode/custody restrictions. Do not replay uncertain operations
or copy a report to claim same-path recovery. If resume is unsupported or cannot
be verified, preserve the old session and record the owner-supported continuation
as unavailable/pending rather than counting a fresh launch as a resume pass.

## Required qualification after manual cleanup

Bind every result to the exact source/package/config bytes, new process identity,
mode/transport and session. Installed PPA may differ from the ticket candidate;
record that distinction rather than equating a version with checked source.

| Route / scenario | Required observation |
| --- | --- |
| Standalone Pi and PPA ordinary managed / Rogue-One, foreground / background | For applicable fresh and eligible-resume cells, capture actual loaded identities, tool/lifecycle registrations, injected context and child activity. Verify capture with an inert canary. No AgentKit activity; unrelated supported extensions and skills remain functional. |
| Protected review / validation | Keep the existing explicit-only baseline and admission restrictions. Do not enter a protected route solely to bypass missing ordinary qualification. |
| AgentKit roots genuinely absent in an owner-admitted disposable setup | Small and genuinely larger ordinary file reads; edit/readback; stale-edit or collision preserving existing bytes; harmless shell operation. No missing-AgentKit prompt, fallback dependency read or privacy-block failure. |
| PA-owned negatives on the same runtime class | Synthetic protected-path denial, sensitive-content redaction and inert command-policy denial, with attributable PA diagnostics and forbidden-effect readback. A different hook's denial is not a PA pass. Never read real credentials for a test. |
| Missing / invalid PA defaults | Separate disposable package twins fail closed with bounded PA diagnostics and no AgentKit/ambient fallback. Never remove or corrupt the live policy asset to test this. |
| Migration and retained history | Old-process exit precedes root changes; new process/session identity and no replay are verified. Original report owners reconcile only admitted active original paths; ended-record recovery remains unavailable. |

Record passed, failed, denied, unavailable and not-run separately. A clean isolated
profile alone cannot hide an unresolved maintained selector in the supported host.
No source test, merge, version, generated report or startup name listing establishes
complete live retirement, independent review, human acceptance or registry settlement.

## Documentation access blocker

The required installed Pi `docs/extensions.md` read was denied during implementation
with `LOCAL_SOURCE_UNSUPPORTED_FILE`. Repository tests and this runbook do not repair
it. The security/runtime owner must establish the permitted selected-document
classification and working reader before dependent harness changes. Do not copy
the denied file, use another reader, change link counts or relax policy as a workaround.
