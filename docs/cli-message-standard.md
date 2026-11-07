# Human-Facing CLI Message Standard

> Repository: pa-platform · Ticket: PAP-246 · Revision: 1
> Scope: documentation rollout; applies to future independently authorized message changes.

## 1. Purpose and scope

A user must understand **what happened, what it means for their task, and what to do next** without knowing the implementation.

This standard covers human-facing PPA/OPA success, progress, information/list/help, warnings, failures and blocked actions. Apply it to messages touched by authorized work, not as a bulk-rewrite instruction. It introduces no runtime behavior, API fields, commands, dependencies, permissions or recovery mechanism. Existing machine-readable contracts remain unchanged.

**MUST** is required for affected messages; **SHOULD** is the default unless a different choice is documented; **MAY** is optional. The rules govern message design and review, not execution authority. Existing operation owners, safety checks and task-specific validation matrices remain authoritative. Publication does not mean existing messages conform or installed enforcement exists.

Reading map: §2 defines the rules; §3 gives synthetic examples; §4 describes agent workflow; §5 defines reporting evidence; §6 locates companions; §7 preserves compatibility; §8 is the review checklist; §9 records provenance.

## 2. Conventions

### C1 — Explain the user's outcome before implementation details

- **C1.1 MUST** lead with the affected task and observed outcome: completed, still running, completed with a limitation, not started, failed after partial work, or outcome unknown. Choose only a state established by the owning operation.
- **C1.2 MUST** explain the consequence relevant to the user's goal. Saving a plan is not approval; approval is not execution; queueing is not running; source checks are not installed verification or user acceptance.
- **C1.3 MUST** give the recommended next action when one is needed. Otherwise state that no action is required when the user might reasonably be unsure. Do not add unnecessary approval warnings or busywork to ordinary success.
- **C1.4 SHOULD** start routine status with one or two sentences. Put codes, internal checks and support references after the explanation, not in place of it. Explain necessary technical terms on first use.
- **C1.5 MUST** preserve material limits, partial effects and uncertainty. Never replace an unknown result with a guessed failure or success. Do not claim nothing changed unless proven.
- **C1.6 MUST** remain understandable in plain text with `NO_COLOR`. Do not depend on icons, color, a browser or links to carry the outcome or required next step. Help and lists may use headings and tables; they do not need the blocker format.

**Why:** Users should not have to decode a module name, exception or workflow code to know whether their task is complete.

**Verify:** A reviewer can identify outcome, consequence and next action/no action from each before/after example without consulting logs or source code. Avoid “Artifact pipeline completed successfully” when only a save step completed.

### C2 — Give bounded, truthful and safe blocker guidance

- **C2.1 MUST** use a short outcome-first headline followed by exactly one each of **Condition**, **Source**, **Reason**, **Correction** and **Resume Action**. The entire rendered diagnostic, including headline, labels, trusted newlines and actions, MUST be at most **2,000 JavaScript characters** (`output.length`, UTF-16 code units). Do not impose this diagnostic format on routine success/progress/help output.
- **C2.2** Condition MUST name the failed or blocked action and whether it started, when known. Source MUST describe the responsible check in readable words. Reason MUST state the actual cause and consequence, or explicitly say it is unproven. Preserve safe native code, gate and correction-owner facts as supporting detail.
- **C2.3** Correction MUST recommend one action first, with at most three actions total. Each action states its impact, responsible actor, approval requirement and prerequisite. Number actions only when ordered. Explain the condition for an alternative; do not offer contradictory unconditional fixes.
- **C2.4 MUST** describe the offered action, not an imagined later effect. Inspection is read-only; waiting or asking for help has no state-changing effect. An owner may need separate authority to repair the problem. Asking for help is not performing that repair.
- **C2.5** Resume Action MUST state what must change before retry. Distinguish observational recheck from an effect request or owner reconciliation. When retry requests an effect, state that admission is checked again; never promise retry success.
- **C2.6 MUST** collapse duplicate wrappers without dropping independent blockers. Distinguish current blockers from checks deferred until a later stage. A missing execution contract does not by itself prohibit safe analysis/drafting.
- **C2.7 MAY** show a command only after verifying exact grammar, adapter/channel, arguments, availability, effects and permitted scope. Use supported read-only inspection for blocker advice. Omit unavailable targeted commands rather than inventing identifiers or paths. Quote validated arguments correctly; never interpolate arbitrary exception text.
- **C2.8 MUST NOT** recommend force-unlock, deleting evidence, returning a checkout, fresh runs, counter resets, blind retries or repeated approvals to conceal retained-state uncertainty or infrastructure failure. Preserve the same intent/resources and route inspection/reconciliation to its owner.

**Action vocabulary:** Impact is `none`, `read-only`, `state-changing`, `destructive` or `unknown`. Actor is `none`, `agent`, `operator`, `administrator` or `unknown`, with a readable owner description when proven. These are explanatory categories, not a new API schema or permission hierarchy. If authority or a prerequisite is unproven, say so and do not offer runnable mutation advice.

**Why:** Guidance must help without inventing authority, hiding uncertain effects or converting infrastructure problems into unnecessary approval loops.

**Verify:** Check label uniqueness, full JavaScript string length, action count and all action metadata. Compare with typed owner facts. Keep current/deferred blockers, absent runs/uncertain retained state, and approval/readiness distinct. Do not achieve the length bound by dropping a material cause or required safety information.

### C3 — Preserve safety, machine contracts and existing owners

- **C3.1 MUST** construct new public guidance from known message text and validated, bounded, non-secret context supplied by existing operation owners. Reuse typed causes and existing bounded presentation helpers before proposing another formatter. Do not infer permissions, process death or successful reconciliation by matching arbitrary error prose.
- **C3.2 MUST NOT** copy raw objectives, arbitrary exceptions, credentials, tokens, password material, bindings or protected resource bodies into new public guidance. A function named `redactDiagnostic` is not proof of sanitization: the historically inspected Pi implementation was pass-through. Verify the applicable implementation rather than relying on its name.
- **C3.3 MUST** keep formatting side-effect-free: zero additional probes, writes, spawns, retries, allocations or recovery. Existing guards still own their observations and effects; do not remove required checks or cleanup to satisfy a formatter test. “Allocations” here means operation/resource allocation, not ordinary in-memory string construction.
- **C3.4 MUST** preserve existing JSON/machine output, exit codes, stdout/stderr routing, API/session-registration behavior and runtime permissions. Do not append prose to JSON or introduce machine fields under a wording-only task. Public machine-contract changes need their own approved scope.
- **C3.5 MUST** preserve the original private-output/audit policy. This standard does not permit global filtering, rewriting history, suppressing original evidence or disclosing private raw output through new support-detail fields.
- **C3.6 MUST** keep adapter boundaries. Shared guidance applies to PPA/OPA, but Pi-only workflow, template, structured-resume and Treehouse facts remain Pi-only. Do not fabricate another adapter's support.

**Why:** Readability must not break automation, leak information, change admission decisions or create a second authority/recovery mechanism.

**Verify:** Compare existing machine/status/stream contracts; test hostile and absent context; use side-effect spies around formatting and public propagation. Report code tests, installed observations and human review as distinct evidence.

## 3. Patterns and examples

All examples are **synthetic wording**, not live command results, permissions or installed behavior. Real output must display actual safely displayable result locations, not the literal phrase “displayed file.” Commands in examples are PPA read-only inspection forms verified in the rollout source; recheck availability and permission in future use. They do not establish OPA support.

### P1 — Success

Use completed action + actual result/location + next step only when needed.

```text
Draft saved to the displayed file.
Next: review its contents before publication.
```

Do not claim an entire workflow completed when only one step did. Ordinary success does not need five labels or irrelevant lifecycle caveats.

### P2 — Progress

Use actual current step + incomplete status + whether to wait or provide input.

```text
Checking repository information.
Please wait for the final result.
```

Report observed milestones. Do not invent percentages, elapsed-time promises or completion; do not claim no changes occurred unless verified.

### P3 — Information / list / help

Use what was queried + result meaning + optional supported usage.

```text
No active deployments match this filter.
No action is required. Remove the filter if you want a broader list.
```

An empty list is not automatically failure. Explain ambiguous columns/options with text, not color alone. Keep existing command names and supported flags.

### P4 — Warning

Use completed/continuing action + limitation + whether action is required.

```text
Draft saved, but its preview could not be generated.
You can review the saved text; preview generation remains unverified.
```

Do not turn a nonblocking preview failure into a claim that the draft was not saved. Never downgrade a real blocker to a warning to continue.

### P5 — Verified ownership blocker

```text
Deployment not started: another builder is using the selected checkout.

Condition: This deployment cannot start on that checkout yet.
Source: Checkout ownership check.
Reason: A builder is active; another writer could conflict with its work.
Correction:
  1. Inspect active deployments with ppa status --running.
     Impact: read-only. Actor: agent or operator. New approval: not required.
     Prerequisite: supported PPA inspection; inspection alone does not prove release.
  2. Wait for the owning builder to finish.
     Impact: none. Actor: operator. New approval: not required.
     Prerequisite: confirmed active owner; do not remove its evidence.
Resume Action: Retry the original request only after the ownership service confirms
availability. The retry will run admission checks again.
```

### P6 — Verified selected-pair blocker

```text
Document production cannot start: the selected config and runtime do not match.

Condition: The requested template operation is blocked.
Source: Selected template compatibility check (TEMPLATE_PAIR).
Reason: The owning check rejected the selected pair; another approval cannot fix it.
Correction:
  1. Inspect the selected template contract with ppa template list --format json.
     Impact: read-only. Actor: agent or operator. New approval: not required.
     Prerequisite: supported selected PPA inspection.
  2. Ask the config/runtime maintainer to reconcile the pair.
     Impact: none. Actor: agent or operator. New approval: not required to ask.
     Prerequisite: retain observed pair evidence; repairs need their own authority.
Resume Action: After supported owner correction, repeat template inspection.
Preserve valid prior decisions; repeated status checks or approvals are not repairs.
```

### P7 — Uncertain result / possible partial effect

```text
Operation outcome unknown after interruption. Do not repeat the request yet.

Condition: The operation may have started; completion cannot be established.
Source: Existing operation-state owner.
Reason: The final result is unavailable; retrying could duplicate an effect.
Correction:
  1. Ask the operator to arrange inspection of the existing operation.
     Impact: none. Actor: agent or operator. New approval: not required to ask.
     Prerequisite: preserve existing evidence; no safe targeted command is available.
Resume Action: Continue only when the owning service establishes the existing result
or authorizes reconciliation. Do not create a replacement intent or fresh run.
Any resumed effect request remains subject to admission checks.
```

### P8 — Multiple causes and later prerequisites

Keep one headline/envelope. Explain each independent current blocker within it, recommended action first, and distinguish later execution prerequisites. Preserve all native machine gate entries. If evidence is insufficient, identify the unknown fact; do not diagnose missing implementation from a generic capability failure. Do not concatenate complete five-field envelopes from each layer.

### Anti-patterns

- “Error: WORKFLOW_CAPABILITY” without the affected task or next step.
- “Argument validation failed” wrapping a verified live-owner failure.
- “Try again” without a changed prerequisite.
- “Run setup/force/reset” with unsupported grammar or unproven effects.
- “No changes were made” after interruption with unknown effects.
- “Everything is ready” when only static inspection or queueing succeeded.
- Repeating technical codes, five labels or approval disclaimers on every progress line.

## 4. Agent working procedure and verification defaults

For future independently authorized message changes:

1. Read this standard and the task scope. Confirm repository/adapter and identify every changed public path, including returned and thrown failures. This document grants no task authority.
2. Record the owning operation's actual outcome, cause, safe context, existing machine/status/stream contract and partial/unknown effects. Do not discover these by probing inside the formatter.
3. Classify each message. Prepare before/after examples showing outcome, consequence and next step. Ask only about material intent/authority gaps; do not repeat unchanged approvals.
4. Reuse typed owners and presentation helpers within the task. Keep codes secondary, context bounded and formatting pure. Do not build a generic recovery framework or modify unrelated messages.
5. Add applicable checks from §8, including actual CLI propagation where wrappers could change meaning. Execute only task-authorized checks through supported admission.
6. Review examples without color or access to source. Fix unclear outcome, cause, actor or next step. Human readability review is separate from structural assertions.
7. Report changed categories, before/after examples, actual results and remaining limits. Failed, skipped, stale, unknown or unperformed checks are not passes. Preserve original failures during bounded repair.

Repository defaults are advisory, **not a new executable matrix or permission grant**:

- Typecheck: `corepack pnpm typecheck`
- Build: `corepack pnpm build`
- Workspace regression: `corepack pnpm test`
- Completions, when affected: `corepack pnpm completions`
- Sensitive-workflow staged scan before commit: `corepack pnpm secrets:scan`

Use that task's authenticated checkout and approved environment, with `NO_COLOR` present for plain-output fixtures. Dependencies/native tooling must already be valid. Checks may create local outputs; use only admitted scope. The staged scanner does not prove unstaged or committed content was scanned. Exact focused entrypoints, order, environment and effects belong to the future task's validation matrix, not this guide.

## 5. Evidence in future change reports

Record:

- Task/ticket, repository, adapter/channel and exact candidate when applicable.
- Affected message paths/categories and before/after examples.
- Actual outcome/cause source and uncertainty; safe public code/reference if useful.
- Recommended action, impact, actor, approval requirement and retry prerequisite for blockers.
- Checks actually executed: exact command, result/exit and evidence location. Separate unrun checks and human review.
- Known limitations and scope/compatibility decisions needing an owner.

Never expose secrets, protected bodies or private raw streams to complete this list. Reports are not new machine authority.

## 6. Authoritative home and companion instructions

This document owns the repository message rules. [Repository instructions](../AGENTS.md) direct agents here; they must not create a second competing standard. Companion announcements describe scope and link here rather than expanding policy.

Repository-local instructions do not change external PA configuration or select a managed guide. Any later `project_guides` adoption belongs to the configuration owner through existing repository-keyed selection. Do not put repository-specific rules in unconditional global instructions or infer managed activation from file existence.

Keep runtime-neutral logic in existing pa-core surfaces and adapter-specific behavior in its adapter when future authorized work requires changes. This is reuse guidance, not a module-creation instruction.

## 7. Compatibility and authority

- Human text and machine JSON keys/types/codes, response semantics, exit codes and streams are separate contracts. The five-field envelope and character bound do not require five JSON keys or an error shape for help/list output.
- Verified non-secret cause/gate/owner facts are support references, not permissions or model-generated successful results.
- Disabled new-run selection, revoked/stale approval, no admitted run and uncertain retained state remain distinct when proven by the runtime. Unknown remains unknown. Source behavior is not proof about an installed runtime.
- Missing execution prerequisites block dependent effects, not every safe read/draft by inference. Approved/queued work still needs live execution/custody admission.
- No new dependency, setup command, config field, approval ledger, retry policy, lease action, API field or runtime capability is introduced. Separate changes need their real scope and owners.
- Recheck relevant source/runtime behavior for future work without replaying completed effects or asking unchanged approvals again.

## 8. Review and test checklist

Apply relevant items to affected messages in future authorized work; these are **not executed results** or a replacement validation matrix.

### Human review

- [ ] Output alone explains what happened, its consequence and next action/no action.
- [ ] Ordinary words lead; codes/internal references support them.
- [ ] Actual changed categories are covered; untouched categories are not claimed tested.
- [ ] Saved/approved/queued/accepted and progress/completion remain distinct.
- [ ] Warnings explain what continues and whether action is needed; empty results explain the query.
- [ ] Unknown/partial effects are not definite success/failure/no change.

### Blocker assertions

- [ ] One headline and exactly one each of Condition, Source, Reason, Correction, Resume Action; no nested envelope.
- [ ] Entire output satisfies `output.length <= 2000`, including labels/newlines/actions; test exactly-at and above-bound inputs.
- [ ] One recommended action, at most three total; each has impact, actor, approval and prerequisite.
- [ ] Real cause/native facts survive adapter/CLI wrappers and both returned/thrown failure paths.
- [ ] Multiple current blockers and later execution prerequisites remain distinguishable.
- [ ] Absent run, unknown retained state, active ownership, genuine approval need and infrastructure failure are not conflated.
- [ ] Safe/absent/hostile identifiers yield supported inspection or no targeted command, never invented commands/identities.
- [ ] Retry wording names changed prerequisites and distinguishes re-observation from effect replay.

### Safety and compatibility

- [ ] Color-disabled text conveys the same outcome and next step.
- [ ] Oversized, multiline, nested-envelope, ANSI/control and synthetic secret-bearing inputs cannot enter new guidance unsafely.
- [ ] Malformed/unknown exceptions, including hostile getters/proxies at untrusted seams, cannot become trusted causes/commands.
- [ ] Spies show zero formatter-triggered probes, writes, spawns, retries, recovery, resource allocation or session registration.
- [ ] Owner decisions, required guard behavior and cleanup are unchanged.
- [ ] Machine output, statuses, exits, stdout/stderr and private-output/audit policy remain compatible.
- [ ] PPA-only capabilities do not appear as OPA support.
- [ ] Actual checks, structural checks, source/installed evidence and human acceptance are reported separately.

Exact commands and applicable coverage belong to each future task. Missing/unrun required cases block that task's acceptance; they are not skipped-and-passing. Structural checks do not prove user comprehension.

## 9. Provenance and rollout boundary

Adapted for repository publication from PAP-246's retained `v002-unapproved` guide:

- Source: `agent-teams/requirements/artifacts/reviews/PAP-246/d-b6e611/v002/repo-agent-cli-message-guidelines.md` in the external ai-usage artifact store.
- Source raw UTF-8 SHA-256: `a7d26d2ae0ee454486965add1033b41cdd25324c5f14b3bee876b817f7da7d52`.
- Antecedent standard: `v001/cli-message-standard.md`, raw SHA-256 `0aac74443e9535c25ae0e236226fa72eb19063ce159b3da4924160b0f0a190f4`.
- Scope correction: ticket comment `c-20261104094325095`; documentation-only rollout intent: `c-20261104124114193`; queue-only override: `c-20261105094445674`; preparation base: `c-20261107060439832`.
- In rollout deployment `d-aea8d0`, the operator selected **Proceed with documentation rollout**: repository docs, repository-agent instruction adoption and repository informational announcement, committed in phases; no runtime code or external configuration changes.

This is a publication adaptation, **not the exact frozen template candidate**, a new native approval receipt, replacement requirements/UAT pair or amended historical matrix. Original artifacts and signed history remain unchanged. The retained guide's C1–C3 rules, patterns, working procedure and checklist are carried forward. Draft-only metadata/paths have been replaced with repository scope; examples consistently use the actor vocabulary; resource allocation and effect-retry admission are clarified. No software/UAT or installed-enforcement claim follows from these document changes.

Historical source observations at `6f7d3462f805ab9f217473da64c2e80f9b9ee395` concerned deploy CLI wrapping, workflow preflight/presentation, Pi `redactDiagnostic` and deploy-control responses. They are dated observations, not permanent runtime facts. Revalidate relevant implementations for future work.

PAP-246 is documentation-only. This standard neither implements the superseded CLI/API feature nor launches builder/reviewer work, repairs workflow routing, publishes a live bulletin or selects a managed project guide.
