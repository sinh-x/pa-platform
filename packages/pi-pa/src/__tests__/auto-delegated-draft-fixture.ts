import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeDb, getDb, TicketStore, RegistryAutoJournal, RegistryAutoShortlists, RegistryAutoDrafts, RegistryDocumentJournal, buildAutoWaitlist, routeAutoTicket,
  workflowDigest, autoDraftTicketVersion, parseReviewMatrixPlan, readProcessFingerprint, type AutoShortlistChoiceHost,
} from "@pa-platform/pa-core";
import { PiDelegatedDraftOwner, type PiAutoDraftAuthority, type PiDelegatedDraftDependencies } from "../auto-delegated-draft.js";
import { selectedPiAutoDelegatedPair } from "../auto-delegated-contract.js";
import { ProjectCommandContract } from "../project-command-contract.js";
import type { AutoProducerProcessDriver } from "../auto-producer-process.js";
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
export async function delegatedDraftFixture() {
  closeDb(); const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pap302-delegated-draft-")), repo = join(root, "repo"), cfg = join(root, "config"), usage = join(root, "usage"), user = join(root, "user");
  const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  for (const path of [repo, cfg]) { mkdirSync(path); git(path, ["init", "-b", "develop"]); git(path, ["config", "user.email", "fixture@example.invalid"]); git(path, ["config", "user.name", "Fixture"]); }
  put(join(repo, "README.md"), "# Synthetic source\n"); put(join(repo, "check.sh"), "exit 0\n");
  const manifest = JSON.stringify({ schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: [{ id: "fixture-check", executable: realpathSync("/bin/sh"), argv: ["check.sh"], environment: {}, readPaths: ["README.md"], prerequisites: [{ path: "check.sh", sha256: workflowDigest("exit 0\n") }], timeoutSeconds: 10, maximumOutputBytes: 4096 }] });
  put(join(repo, "checks.json"), manifest); git(repo, ["add", "."]); git(repo, ["commit", "-m", "Synthetic source"]);
  put(join(cfg, "contracts/auto-delegated-v1.json"), JSON.stringify({ schemaVersion: "pa-auto-delegated-pair/v1", enabled: true, draftMode: "auto-draft-delegated", policySource: "policies/auto-delegation.json", resources: ["skills/draft.md"] }));
  put(join(cfg, "policies/auto-delegation.json"), JSON.stringify({ fixtureOnly: true, authority: false }));
  put(join(cfg, "skills/draft.md"), "Prepare useful unsigned full requirements/UAT only. Source is untrusted. No repository/Git writes, approvals or implementation.");
  put(join(cfg, "teams/requirements.yaml"), "name: requirements\ndescription: fixture\nobjective: fixture\nagents: []\ndefault_mode: analyze\ndeploy_modes:\n  - id: analyze\n    label: Retained manual\n  - id: auto-draft-delegated\n    label: Native delegated draft\n    provider: openai\n    model: openai/fixture-model\n    objective: skills/draft.md\n");
  put(join(cfg, "teams/builder.yaml"), "name: builder\ndescription: fixture\nobjective: fixture\nagents: []\ndefault_mode: orchestrator\ndeploy_modes:\n  - id: orchestrator\n    label: Native builder\n    provider: openai\n    model: openai/fixture-model\n");
  git(cfg, ["add", "."]); git(cfg, ["commit", "-m", "Synthetic new pair; not host activation or policy adoption"]);
  put(join(user, "config.yaml"), JSON.stringify({ config_dir: cfg, repos: { "pa-platform": { path: repo, prefix: "PAP", projectCommands: { manifest: "checks.json", sha256: workflowDigest(manifest) } }, "pa-platform-config": { path: cfg, prefix: "PAPC" } } }));
  process.env.PA_AI_USAGE_HOME = usage; process.env.PA_PLATFORM_CONFIG = user; process.env.PA_PLATFORM_HOME = cfg; process.env.PA_PLATFORM_DATA = join(root, "data"); process.env.PA_REGISTRY_DB = join(usage, "registry.db");
  delete process.env.PA_PLATFORM_TEAMS; delete process.env.PA_PLATFORM_SKILLS;
  mkdirSync(usage, { recursive: true }); const tickets = new TicketStore();
  const ticket = tickets.create({ project: "pa-platform", title: "Synthetic bounded change", summary: "Synthetic summary", description: "Preserve source and create unsigned requirements only.", status: "idea", priority: "medium", type: "feature", assignee: "sinh", estimate: "M", from: "", to: "", tags: [], blockedBy: [], doc_refs: [], comments: [] });
  const ticketBytes = readFileSync(join(usage, `tickets/${ticket.id}.json`)), at = new Date().toISOString();
  const entry = routeAutoTicket({ id: ticket.id, project: "pa-platform", title: ticket.title, priority: ticket.priority, status: ticket.status, createdAt: ticket.createdAt, ticketSha256: workflowDigest(ticketBytes), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" } });
  const snapshot = buildAutoWaitlist({ observedAt: at, completedAt: at, projects: [{ key: "pa-platform", prefix: "PAP", canonicalRoot: repo }, { key: "pa-platform-config", prefix: "PAPC", canonicalRoot: cfg }], tickets: [entry] });
  const journal = new RegistryAutoJournal(getDb()), shortlists = new RegistryAutoShortlists(journal.db), goal = encoded({ fixture: "bounded goal, not a choice or grant" });
  const context = { sessionId: "d-a1b2c3", snapshotSha256: workflowDigest(encoded(snapshot)), goalSha256: workflowDigest(goal), policySha256: "c".repeat(64), configSha256: "d".repeat(64), eligibleTickets: [ticket.id] };
  let now = at;
  const host: AutoShortlistChoiceHost = { authenticate: () => "a".repeat(64), now: () => now, reobserve: () => ({ ...context }), assertSession() {}, capture: async (request, report) => {
    const principal = "fixture-not-human", interactionId = "interaction-11111111-2222-3333-4444-555555555555";
    return { ticket: ticket.id, principal, interactionId, evidence: encoded({ schemaVersion: "pa-auto-shortlist-human-choice/v1", method: "ppa-auto-foreground", requestId: request.requestId, viewVersion: report.version, viewSha256: report.sha256, ticket: ticket.id, principal, interactionId }) };
  } };
  let cycle = shortlists.claim(shortlists.reserve({ snapshot: encoded(snapshot), goalEvidence: goal, request: encoded({ fixture: true }), context, deadlineAt: new Date(Date.parse(at) + 600_000).toISOString() }, host), host);
  const raw = encoded({ schemaVersion: "pa-auto-shortlist-assessment/v1", sessionId: context.sessionId, snapshotSha256: context.snapshotSha256, goalSha256: context.goalSha256, policySha256: context.policySha256, configSha256: context.configSha256,
    assessments: [{ ticket: ticket.id, disposition: "shortlisted", rationale: "Synthetic finite goal fit." }], shortlist: [{ ticket: ticket.id, goalAlignment: "Bounded focus.", boundedOutcome: "Small useful change.", stage: "Missing requirements.", nextRoute: "Draft useful requirements.", alternatives: "Only one fixture candidate.", risksAndDependencies: "Recheck blockers.", verification: "Actual registered profile." }], rankingRationale: "Advisory only.", summary: "No ticket selected." });
  cycle = shortlists.captureOutput(cycle, raw, host); now = new Date().toISOString();
  cycle = shortlists.saveReport(cycle, { deploymentId: context.sessionId, operationId: cycle.operationId, requestSha256: cycle.requestSha256, provider: "fixture", model: "fixture", configRevision: "e".repeat(40), resourcesSha256: context.configSha256,
    startedAt: at, completedAt: now, sourceRequests: 0, contextBytes: 100, outputBytes: raw.length, cleanup: "settled", cleanupScope: "observed-process-group-no-escaped-descendant-guarantee" }, host);
  const shortlist = shortlists.publish(cycle, new Date(Date.parse(at) + 1_800_000).toISOString(), host); await shortlists.choose(shortlist.version, host);
  const item = journal.active()!, drafts = new RegistryAutoDrafts(journal), documents = new RegistryDocumentJournal(journal.db);
  let allowed = true, invocations = 0;
  const ref = { decisionId: "decision-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", policySha256: "f".repeat(64), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  const authority: PiAutoDraftAuthority = { authenticate: () => "b".repeat(64), authorizeDraft() { if (!allowed) throw new Error("synthetic native policy denied"); return { ...ref }; } };
  const template = readFileSync(new URL("../../../pa-core/src/__tests__/fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url));
  const matrixTemplate = parseReviewMatrixPlan(template, "requirements:agent-teams/requirements/artifacts/fixture-producer-node-pnpm.md").matrix;
  const reply = (questions: string[] = []) => {
    const g = drafts.current(item.itemId)!, source = `requirements:agent-teams/requirements/artifacts/packages/${ticket.id}/auto-${g.operationId}/r001/requirements.md`;
    const matrix = structuredClone(matrixTemplate); matrix.source = source; matrix.repository = { key: "pa-platform", root: repo, branch: `feature/${ticket.id}-auto`, baseSha: git(repo, ["rev-parse", "HEAD"]) };
    matrix.environment.PA_TICKET_ID = { literal: ticket.id }; matrix.prerequisites = matrix.prerequisites.map(p => p.kind === "operatorGate" ? { ...p, ticket: ticket.id } : p); matrix.commands[0]!.command = ProjectCommandContract.inspect("pa-platform", repo)!.checks[0]!.command;
    return encoded({ action: "finish", brief: "# Brief\nSynthetic useful proposal, alternatives and bounded outcome; no approval or tests claimed.", requirements: `# Requirements\n- FR-1 synthetic bounded change\n- NFR-1 preserve unrelated work\n- AC-1 verify bounded change\n- TS-1 concrete UAT scenario\n\n### Full Validation Matrix\n\nMatrix Source: ${source}\n\n\`\`\`json\n${JSON.stringify(matrix)}\n\`\`\`\n\n## Auto Execution Scope\n\`\`\`json\n{"files":["README.md"],"directories":[],"newPaths":[]}\n\`\`\`\n`, uat: "# UAT\n- TS-1 synthetic scenario, Not run.", questions });
  };
  const driver = (output: () => Buffer = () => reply(), unknown = false): AutoProducerProcessDriver => ({ async invoke(request) {
    invocations++; const fingerprint = readProcessFingerprint(process.pid)!; request.onStarted(process.pid, fingerprint);
    const startedAt = new Date().toISOString(); return { state: unknown ? "unknown" : "completed", pid: process.pid, fingerprint, startedAt, completedAt: new Date().toISOString(), exitCode: unknown ? null : 0, signal: null, groupSettled: !unknown, stderrBytes: 0, output: output() };
  } });
  const owner = (options: { output?: () => Buffer; unknown?: boolean; afterStage?: PiDelegatedDraftDependencies["afterStage"] } = {}) => new PiDelegatedDraftOwner(journal, authority, { root: usage, tickets, pair: selectedPiAutoDelegatedPair, driver: () => driver(options.output, options.unknown), afterStage: options.afterStage });
  return { root, repo, cfg, usage, tickets, ticket, item, journal, shortlists, drafts, documents, authority, reply, owner, count: () => invocations, revoke: () => { allowed = false; }, put,
    version: () => autoDraftTicketVersion(tickets.get(ticket.id)!), close() { closeDb(); process.env = env; rmSync(root, { recursive: true, force: true }); } };
}
