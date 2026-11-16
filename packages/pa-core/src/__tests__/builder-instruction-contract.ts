import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTeamYamlContent } from "../index.js";

// Source-test profile, never admission or activation. Unknown/mixed profiles fail;
// retained split profiles still execute their original assertions unchanged.
export function directBuilderProfile(root: string): boolean {
  const team = parseTeamYamlContent(readFileSync(join(root, "teams/builder.yaml"), "utf8"));
  const modes = team.deploy_modes ?? [];
  const direct = team.default_mode === "orchestrator" && !modes.some(mode => mode.id === "implement");
  if (direct) {
    const mode = modes.find(mode => mode.id === "orchestrator");
    assert.ok(mode, "direct profile requires orchestrator");
    assert.equal(mode.require_ticket, true, "direct implementation requires a ticket");
  } else {
    assert.equal(team.default_mode, "implement", "unsupported builder instruction profile");
    assert.ok(modes.some(mode => mode.id === "implement"), "split profile requires implement");
  }
  return direct;
}

// Literal independently required boundaries. Examples support offline negative
// tests without treating a synthetic text body as native/runtime proof.
export const directContracts = {
  ticket: [
    "Missing ticket stops before report/ticket/Git/child mutation.",
    "## Startup and plan",
  ],
  identity: [
    "Registry `repo_key` resolves canonical `repo_root`; `worktree_root` is distinct.",
    "`PA_REPO`, runtime CWD, Git top-level, deployment context and registry start evidence equal that worktree;",
    "protected evidence binds exact ticket/branch/base, capacity, lineage, authority source, sole orchestrator holder, checkout/lease and matching finalization.",
    "Duplicate lineage, fifth checkout, wrong root/ticket/branch or stale/missing/conflicting binding rejects before project-file/branch mutation and child/runtime spawn.",
  ],
  branch: [
    "Only orchestrator performs the exact ordinary-Git branch action after supported authentication and requirements/ticket agreement: planned/create from the approved full base, or materialized/select of the exact linked branch.",
    "Reuse a proven result; never repeat branch construction.",
    "Persist action/result, exact branch/full HEAD, dual-root identity, checkout/lease, capacity, lineage/correlation and launch snapshot before implementation.",
    "OPA/CPA use their supported clean exact ticket-branch gate; no Treehouse claim.",
    "No stash/reset/cleanup/discard, substitute checkout or force override of a live holder.",
  ],
  holder: [
    "No implement fallback or implementation-child launch.",
    "One active builder lineage per repository/ticket; at most four active ticket checkouts per canonical repository, including ready retained resources.",
    "Legacy live or uncertain implement holders block direct takeover.",
    "quiet logs, a partial report or mode retirement is not settlement.",
  ],
  repair: [
    "In-scope findings are fixed DIRECTLY by the admitted orchestrator; new commit/SHA, push/PR update, fresh independent review and CI.",
    "EVERY named phase check before commit.",
    "Never compose a builder-child objective, dispatch implement or invent OBJ/IMP IDs.",
    "Review findings and UAT fixes use this SAME direct loop and actual sole-holder admission, never an implementation child or a new repair allowance.",
  ],
  reportIdentity: [
    "> Version: 6.1",
    "Repository Key / Repository Root: <canonical binding>",
    "Worktree Root / Ticket / Branch State / Branch Action/Result: <supported actual evidence>",
    "Launch Snapshot / Authority Final Snapshot: <branch/full HEAD/complete NUL-safe inventory>",
    "Local Work Result / Process Liveness / Staged Completion / Final Settlement: <separate facts or unknown>",
  ],
  reportPhase: [
    "No new implementation-child objectives/brackets/replacements, OBJ/IMP IDs or borrower receipts.",
    "## Direct phase index",
    "| Deployment/phase/attempt | Scope/FR/NFR/AC/check plan | Sole source/check holder | Baseline/overlay/final SHA or no-commit | Canonical report/diff/streams | Failure/remedy/rechecks/counters | First unproven action/owner |",
    "one row per phase/attempt, including failed/interrupted/no-commit/reconstructed outcomes and original failure/recovery.",
  ],
  reportBranch: [
    "exact protected binding, dependencies, current Git, first unproven action",
    "For Pi/PPA, protected launcher/registry evidence binds canonical repo_key/ repo_root to distinct authenticated worktree_root, exact ticket/branch/base/HEAD, checkout/lease, capacity, lineage, source/holder and matching finalization.",
    "Wrong/missing/stale/duplicate/self-asserted/conflicting binding rejects before mutation or spawn.",
    "OPA/CPA retain supported non-Treehouse behavior with no Treehouse claim.",
  ],
  reportReview: [
    "Full matrix belongs only to independent review-auto.",
    "CI, UAT and merge bind Feature SHA, Matrix Authority SHA-256, Review Authorization ID and Review Deployment ID.",
    "Background hands off review-uat/Sinh without merge/done.",
    "Persist approver/time/decision before integration.",
  ],
} as const;
export type DirectContract = keyof typeof directContracts;
const flat = (text: string) => text.replaceAll("**", "").replace(/\s+/gu, " ").trim();
export function assertDirectContract(kind: DirectContract, text: string): void {
  const body = flat(text);
  for (const clause of directContracts[kind]) assert.ok(body.includes(flat(clause)), `direct ${kind}: missing ${clause}`);
  assert.doesNotMatch(body, /(?:Delegate the fix to `builder\/implement`|--mode implement|Skip independent review|Unknown checks pass|Reset exhausted counters)/u);
}
