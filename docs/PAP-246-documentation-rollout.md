# PAP-246 Documentation Rollout

## Scope and operator decision

This rollout publishes repository documentation only, superseding the old CLI/API implementation framing without rewriting its historical approvals or matrix. In deployment `d-aea8d0`, the operator selected **Proceed with documentation rollout**: publish the standard/guide, adopt it in repository-agent instructions, and add a repository informational announcement, committing each phase separately. Runtime code and external configuration are out of scope.

Prepared on `feature/PAP-246-deployment-block-guidance` at base `0e4096400ce1d2c6401385a5db882eef412847ef`. This is the selected ticket worktree, not a change to the canonical checkout or permission to return its lease.

## Deliverables and phases

| Phase | Repository deliverable | Commit |
|---|---|---|
| 1 | [CLI message standard](cli-message-standard.md), indexed in docs/README.md | `015ef81` — `docs(PAP-246): publish human-facing CLI message standard` |
| 2 | [Repository-agent instructions](../AGENTS.md) refer to the standard and its procedure/checklist | `05d54bd` — `docs(PAP-246): adopt CLI standard in repository instructions` |
| 3 | [Informational announcement](bulletins/PAP-246-cli-message-standard.md), this record, and index entries | `40a2f17` — `docs(PAP-246): announce documentation-only CLI standard rollout` |
| 4 | Migrate repository instructions to AGENTS.md and remove repository-specific Claude files | Containing commit — `docs(PAP-246): migrate repository instructions to AGENTS.md` |

The standard is the single repository rule owner. The instructions and announcement point to it rather than creating parallel policy. Scope covers all human-facing message categories, not only blockers. Existing output is not automatically migrated or claimed conformant.

## Retained source and adaptation

The retained external review guide is unchanged:

- `agent-teams/requirements/artifacts/reviews/PAP-246/d-b6e611/v002/repo-agent-cli-message-guidelines.md`
- Revision `v002-unapproved`; raw UTF-8 SHA-256 `a7d26d2ae0ee454486965add1033b41cdd25324c5f14b3bee876b817f7da7d52`.

The repository standard is an adaptation, not a byte-identical canonical-template result or native workflow approval. It carries forward all 20 C1–C3 rules, seven sample outputs plus the multiple-cause pattern, seven-step agent procedure, and 22-item checklist. Publication metadata replaces draft-only status/paths; the document now owns the repository rules. Example actors use the defined vocabulary, resource allocation excludes ordinary string construction, and uncertain-effect resume explicitly preserves admission checks. Historical observations remain labeled historical, not installed facts.

The external v001/v002 artifacts, signed requirements/UAT, matrix, ticket queue, workflow routing and branch history were not rewritten by this rollout. A direct operator choice to publish this adaptation is not an issued native decision or a replacement requirements package.

## Checks actually performed

Document checks were executed through inline Node assertions and Git checks in deployment `d-aea8d0`:

- Phase 1: nine numbered sections, all 20 rule identifiers exactly once, 22 checklist items, seven fenced sample outputs, valid local Markdown links and no disallowed control characters. Retained v002 source hash matches the value above.
- P5/P6/P7 synthetic blocker examples: **797 / 898 / 748 JavaScript characters** respectively, measured on the fenced message content. Each has exactly one of every required label, one or two actions (maximum three), and impact/actor/approval/prerequisite metadata for every action. These are sample checks, not formatter boundary tests.
- Phase 2: all message categories and the standard link/section references were verified in the instruction file then named CLAUDE.md (now AGENTS.md). Existing branch strategy, development checks and release instructions are unchanged. Documentation-only scope and the external-selection boundary are explicit.
- Phase 3: local links across every changed Markdown file resolve; standard structure/examples and frozen-source hash rechecked; the complete changed-file set was documentation and the repository instruction file only. Announcement and rollout boundaries checked for live-bulletin and external-guide nonactivation.
- Each phase: `git diff --check` and staged `corepack pnpm secrets:scan` passed before its commit. The scanner covers staged files only; it is not a global secret audit.

Manual source review checked that the standard retains outcome/consequence/next-step rules for every category, real-cause/action/authority guidance for blockers, and safety/machine-contract/adapter boundaries. This is agent document review, not human comprehension acceptance.

**Not run:** typecheck, build, workspace tests, completions generation, historical executable matrix, formatter/CLI runtime fixtures, installed qualification, browser/Obsidian observation or human UAT. This documentation-only rollout makes no software behavior, readability-UAT or installed-enforcement claim. Future implementations must supply their own applicable evidence, including exact-bound/above-bound formatter tests.

## Repository instruction filename migration

After phase 3, the operator explicitly selected **Use AGENTS.md; remove repo-specific Claude files**. The root instruction file is now [AGENTS.md](../AGENTS.md); the root CLAUDE.md and `.claude/` configuration directory are removed from this checkout. Branch rules formerly in `.claude/branch-strategy.yaml` are preserved in AGENTS.md, including release-only merges and hotfix routing. README and current documentation links point to AGENTS.md.

The instruction content, standard, and development/release guidance are preserved. Historical mentions above describe the filenames used by the original checks, not current files. Runtime compatibility, security checks, third-party vendored content and external managed-guide selection remain unchanged. No Git history or retained review artifact is rewritten.

## Adoption and delivery boundaries

| Surface | Actual status |
|---|---|
| Repository standard | Published on this feature branch; no merge/push or installed-runtime claim |
| Repository-local instructions | AGENTS.md points to the standard; branch-local adoption |
| Repository announcement | Informational Markdown in docs; no deployment blocking or automatic delivery |
| Managed PA `project_guides` | Unchanged; no external selection/activation performed |
| Live PA bulletin | Not created; no repository-only/nonblocking publishing contract established |
| Runtime feature / API | Unchanged; superseded implementation not performed |
| Ordinary documentation workflow routing | Not repaired; rogue-one rollout does not prove normal workflow readiness |

Bulletin inspection used `packages/pa-core/src/cli/commands/bulletin.ts` and `packages/pa-core/src/bulletins/types.ts` at the selected base: creation accepts title/block/except/message, requires a block target, and exposes no repository field or explicit nonblocking informational mode. No live creation was attempted. Do not simulate the missing contract with a global notice, fake team or protected-store edit.

Any later managed-guide adoption or live announcement needs its real configuration/publication owner and a supported repository-only informational channel. That remaining distribution boundary does not undo the repository deliverables and does not require replaying unchanged approval or branch-link actions. No builder/reviewer was launched, no checkout returned, and no ticket completion or native workflow settlement is asserted here.
