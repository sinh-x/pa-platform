# Opencode Primer Parity Matrix

> Ticket: PAP-022
> Phase: 4.1 - Parity matrix
> Date: 2026-04-28
> Baseline: `/home/sinh/git-repos/sinh-x/tools/personal-assistant`
> Target: `/home/sinh/git-repos/sinh-x/tools/pa-platform`

This matrix records generation-related differences between frozen Old PA and pa-platform for skills, team configuration, and primer generation. Classifications are:

- Intentional: opencode/runtime adaptation or pa-platform packaging choice.
- Remediation: required in PAP-022 phases 4.2-4.4.

## Skills

| Area | Old PA baseline | pa-platform | Classification | Notes |
|---|---|---|---|---|
| Operational global PA skills | Runtime primer loaded `~/.claude/skills/pa-session-log`, `pa-ticket-workflow`, `pa-startup`; available-skill summaries also read `~/.claude/skills/<name>/SKILL.md`. | Canonical copies exist under `skills/global/<name>/SKILL.md` and generated primers inline them as shared skills when listed by team mode. | Remediation R1 | Generated skill `path=` values must resolve to pa-platform packaged `skills/`, not nix-store missing paths or `~/.claude/skills`. |
| Terse mode | Old PA injected `~/.claude/skills/terse-mode/SKILL.md` when `terse_mode: true`. | `collectSkills` adds `terse-mode`, but pa-platform has no `skills/global/terse-mode/SKILL.md`, producing missing-skill output in builder primers. | Remediation R2 | Either package a pa-platform terse-mode skill or stop injecting it until available. |
| Core standards | Old PA always injected `skills/global/standards/core.md` inline. | No `skills/global/standards/core.md`; equivalent procedures split across `pa-*` shared skills and memory docs. | Remediation R3 | Primer generation must restore required procedural coverage without external Claude Code paths. |
| Reference standards | Old PA listed `kanban-workflow`, `workflow-policy`, `codebase-exploration`, and `impact-analysis` as on-demand reference docs. | pa-platform has `pa-ticket-workflow`, `pa-communication`, and related skills, but no reference-doc table in generated primers. | Remediation R4 | Add opencode-safe reference/skill availability so agents know when to consult these procedures. |
| Requirements active skills | Old PA requirements skills exist in `skills/requirements/*.md`. | Matching requirements skills exist and include newer ambiguity/self-review/sign-off content. | Intentional | Newer requirements safeguards preserve and extend old behavior; command names can be adapted by generation. |
| Requirements command wording | Old PA and some pa-platform requirement skills still say `pa ticket`, `pa deploy`, and legacy `--interactive` in source. | Primer generator adapts known `pa` commands to `opa` at render time; some source text was already changed to remove `--interactive`. | Intentional with test gap | Runtime adaptation is correct for opencode, but Phase 4.4 needs fixture tests to prevent generated legacy command leakage. |
| Requirements template | Old PA has `skills/templates/requirements.md` with the 13-section checklist referenced by `skills/requirements/analyze.md`. | `skills/templates/requirements.md` is absent while `skills/requirements/analyze.md` still references it. | Remediation R5 | Restore the template or redirect the reference to an existing pa-platform source. |
| Template/reference skills | Old PA includes `skills/templates/{requirements,uat-review,implementation-artifact,builder-objective,done-summary,idea-intake,orchestration-report}.md`. | pa-platform does not include `skills/templates/`. | Remediation R6 | Restore only generation-relevant templates used by active primer reference docs or active skills. |
| Old team-specific skills | Old PA has extra skill trees for daily-summary, sprint-master, kpi-reviewer, maintenance, secretary, rpm, signal, knowledge-hub, self-improvement, and youtube processing. | pa-platform currently includes only requirements skills plus global PA workflow skills. | Intentional | Not all are active in pa-platform team modes today; audit should stay limited to skills referenced by active `teams/*.yaml`, generated primers, and requirements handoff templates. |
| Skill frontmatter shape | Old PA shared-skill summaries read YAML frontmatter from external Claude skill files. | pa-platform inlines full `SKILL.md` files from packaged skills. | Intentional | Full inline shared skills are appropriate for opencode and avoid requiring a separate Read step for shared procedures. |

## Teams

| Area | Old PA baseline | pa-platform | Classification | Notes |
|---|---|---|---|---|
| Active team set | `teams/*.yaml` contains builder, requirements, sprint-master, maintenance, planner, learner, kpi-reviewer, insights, plus `example.yaml`. | Same active production teams except `example.yaml`; no `daily.yaml` despite daily mode files existing in both trees. | Intentional | `example.yaml` is not active runtime config; daily mode files are legacy/unused without team YAML. |
| Port markers | No port marker comments. | Team YAML and mode files include `Ported from frozen PA...` comments. | Intentional | Migration traceability; non-operational. |
| Requirements analyze modes | Old PA has analyze, review, review-auto, review-auto-anthropic, focus, focus-anthropic, spike, spike-anthropic, analyze-auto, analyze-auto-anthropic. | Same plus `analyze-auto-openai` with `provider: openai` and `model: gpt-5.5`. | Intentional | OpenAI mode is an opencode-supported provider addition. |
| Requirements provider typing | Old PA provider hints use `anthropic` and `minimax`. | Team config includes `openai`, but `DeployMode.provider` and provider defaults types omit `openai`. | Remediation R7 | Type definitions should include supported opencode providers where config accepts them. |
| Requirements interactive guidance | Old PA notes say use `--interactive` for analyze/review. | pa-platform notes say foreground TUI is default; some skills remove `--interactive`. | Intentional | `opa deploy` foreground behavior replaces the legacy `--interactive` flag. |
| Builder modes | Builder config and mode docs are effectively identical except port markers. | Same, with active skills resolved from pa-platform. | Intentional with R2/R4 dependency | Builder primers still expose missing terse-mode and lack old deployment-instruction coverage. |
| Provider/runtime framing | Old PA team configs are Claude Code oriented but include provider hints. | pa-platform config is runtime-neutral and adapters map runtime-specific model/provider behavior. | Intentional | Preserve shared team config while opencode adapter injects opencode tool/provider guidance. |
| Learner command wording | Old PA text says `pa deploy learner --interactive`. | pa-platform says `pa deploy learner`; opencode render adapts `pa deploy` to `opa deploy`. | Intentional | Removes legacy interactive flag while preserving command semantics. |

## Primer Generation

| Section/behavior | Old PA baseline | pa-platform | Classification | Notes |
|---|---|---|---|---|
| Header and identity | `# Deployment Primer: <team>` plus explicit "You are being deployed as the team manager". | `# PA Deployment Primer` with `Runtime`, `Team`, and `Mode`. | Intentional | Runtime label is useful for opencode; identity detail is partly covered by mode objectives and deployment context. |
| Deployment context | Always includes deployment id, registry DB, workspace paths, cwd/repo, ticket, agents, models, mode. | Added by opencode `buildExtraInstructions` only when a ticket exists; `repo_root` is resolved as `resolve(cwd, repo)` which can duplicate/warp absolute paths. | Remediation R8 | Deployment context should be consistently available and should preserve absolute repo paths. |
| Objective ordering | Old PA renders agents first, then objective/additional instructions. | pa-platform renders objective and user objective before team/agents/tools/skills. | Intentional | Difference is presentational unless procedures depend on earlier deployment context. |
| Agent instructions | Old PA supports `agent.instruction ?? agent.skill`, rendering `<instruction-file>` or `<skill-file>`. | pa-platform supports `instruction` only. | Intentional | Active pa-platform agents use `instruction`; no current generation requirement needs `agent.skill` fallback. |
| Available skills | Old PA renders a summary table with external `~/.claude/skills` paths and tells agents to Read skills when needed. | pa-platform inlines selected skill bodies from `skillsDir/<name>/SKILL.md`. | Intentional with R1/R2 | Inlining is good for opencode; path resolution must use packaged pa-platform skills. |
| Core standards | Old PA injects core standards inline. | No equivalent generated section. | Remediation R3 | Required procedural coverage must be restored using pa-platform skills/docs. |
| Model policy | Old PA renders a model policy when effective models are present. | pa-platform does not render a model policy. | Intentional | opencode tool/provider framing is sufficient for current objective; no AC requires dynamic model policy. |
| Improvement focus | Old PA can inject scoped improvement focus items. | pa-platform does not. | Intentional | Not generation-critical for PAP-022 acceptance criteria. |
| Codebase context | Old PA injects codebase context when a codectx graph exists. | pa-platform does not. | Intentional | Useful but not required for opencode primer parity in this ticket. |
| Reference documents | Old PA lists repo context, standards, and lifecycle templates as read-on-demand docs. | pa-platform lacks a reference-doc section. | Remediation R4/R6 | Needed so requirements/builders can discover templates and standards without external Claude paths. |
| Active bulletins | Old PA injects active bulletins directly into primers. | pa-platform relies on `pa-startup`/`pa-bulletin` skills and runtime pre-flight, but generated primer has no active bulletin section. | Remediation R9 | Restore active bulletin awareness in generated primers or make startup skill mandatory and test-covered. |
| Deployment instructions | Old PA renders solo/team deployment instructions and explicitly names required startup/session/ticket skills. | pa-platform relies on mode objective and injected shared skills; no generated shutdown/team instructions section. | Remediation R10 | Restore opencode-safe deployment instructions without TeamCreate/SendMessage/Agent/AskUserQuestion/ScheduleWakeup requirements. |
| Runtime tool guidance | Old PA deployment instructions mention Claude Code team tools. | pa-platform injects opencode tool guidance and supported providers `minimax` and `openai`. | Intentional | Preserve this framing; later tests should ban Claude-only operational tool instructions in opencode output. |
| Memory docs | Old PA did not inject Claude/OPENCODE memory docs from deploy wrapper. | pa-platform opencode deploy injects memory docs to emulate Claude Code behavior. | Intentional with risk | Useful compatibility layer, but generated operational skill dependencies should still resolve to pa-platform. |
| Command adaptation | Old PA outputs `pa` commands and ClaudeCode env handling. | pa-platform adapts known `pa` CLI invocations to `opa` and strips `CLAUDECODE` lines for opencode. | Intentional with test gap | Phase 4.4 should assert generated primers contain no legacy `pa <subcommand>` commands. |

## Remediation Items For Later Phases

| ID | Required remediation | Likely phase |
|---|---|---|
| R1 | Ensure generated opencode primers source operational PA skills from pa-platform `skills/`, with package-resolvable paths and no dependency on external Claude Code skill folders. | 4.2 / 4.4 |
| R2 | Fix missing `terse-mode` injection for teams with `terse_mode: true`. | 4.2 |
| R3 | Restore Old PA core procedural coverage in opencode-safe form: startup priority, ticket workflow, session logging, failure handling, shutdown/registry. | 4.2 / 4.4 |
| R4 | Restore an opencode-safe reference-doc/available-procedure section for standards and lifecycle docs. | 4.2 |
| R5 | Restore `skills/templates/requirements.md` or update requirements skill references to a real pa-platform source containing the 13-section checklist. | 4.3 |
| R6 | Restore generation-relevant templates referenced by Old PA primer generation, especially requirements and implementation/UAT handoff templates. | 4.3 |
| R7 | Update provider/runtime typing so `openai` is represented where team config accepts provider hints. | 4.2 |
| R8 | Fix opencode deployment context generation so absolute repo paths are preserved and context is not ticket-only when generated primer behavior depends on it. | 4.2 |
| R9 | Add active-bulletin awareness to generated opencode primers or test-covered mandatory startup skill instructions. | 4.2 / 4.4 |
| R10 | Add opencode-safe deployment instructions for solo/team modes without Claude-only operational tools. | 4.2 / 4.4 |
| R11 | Add regression fixtures for requirements analyze mode and representative builder mode, asserting required sections are present and banned legacy/Claude-only operational references are absent. | 4.4 |

## Verification Notes

- Compared `teams/` trees with recursive diff. Differences were limited to port comments, omission of Old PA `example.yaml`, opencode/openai requirements mode additions, foreground TUI wording, and non-operational newline changes.
- Compared `skills/` trees with recursive diff. Requirements skills are present with opencode/runtime updates; global/template/team-specific Old PA skills have not all been ported.
- Read Old PA `src/lib/primer.ts` and pa-platform `packages/pa-core/src/primer/index.ts`, `packages/opencode-pa/src/deploy.ts`, `packages/opencode-pa/src/adapter.ts`, `packages/pa-core/src/types.ts`, and `packages/pa-core/src/__tests__/primer.test.ts` to classify generated-primer behavior.
- No full repository verification was run for this audit-only phase; final verification remains Phase 4.5.
