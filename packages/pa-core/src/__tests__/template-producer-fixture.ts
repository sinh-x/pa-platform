// Synthetic disposable producers; never canonical prose or durable approvals.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { digest } from "../templates/schema.js";
import { templateService } from "../templates/service.js";
import { workflowProducerBindings } from "../templates/binding-contracts.js";
import { parseReviewMatrixArtifact } from "../validation/review-contract.js";
import { resolveOrdinaryTaskBaseline } from "../tickets/materialization.js";
import { TicketStore } from "../tickets/store.js";
import { templateFixture } from "./template-fixture.js";

export const pairTemplate = "PA pair-signoff/v1\nDecision: approve-pair-and-matrix\nTicket: {{ticket}}\nRepository Key: {{repositoryKey}}\nRepository Root: {{repositoryRoot}}\nHandoff Type: {{handoffType}}\nFeature Branch: {{branch}}\nBase SHA: {{baseSha}}\nBranch Action: {{#featureSha}}select{{/featureSha}}{{^featureSha}}create{{/featureSha}}\nLinked Branch State: {{#featureSha}}materialized{{/featureSha}}{{^featureSha}}planned{{/featureSha}}\nReview Revision: {{reviewRevision}}\nRequirements Source: {{requirementsSource}}\nRequirements Preview: {{requirementsPreviewPath}}\nRequirements Raw SHA-256: {{requirementsPreviewSha256}}\nUAT Preview: {{uatPreviewPath}}\nUAT Raw SHA-256: {{uatPreviewSha256}}\nMatrix Source: {{matrixSource}}\nMatrix Authority SHA-256: {{matrixSha256}}{{#featureSha}}\nCurrent Feature SHA: {{featureSha}}\nAmendment Source Requirements Ref: {{amendmentSource}}\nAmendment Tuple Approval Evidence: {{tupleApprovalEvidence}}\nAmendment Immediate Reread SHA-256: {{immediateRereadSha256}}\nAmendment Final Reread SHA-256: {{finalRereadSha256}}{{/featureSha}}";
export function handoffTemplate(kind: "fresh" | "amendment"): string {
  return `# Synthetic handoff fixture\n\n> Handoff Contract: pa-task-handoff/v1\n> Status: Draft\n> Route: builder/orchestrator\n> Ticket: {{ticket}}\n> Repository Key: {{repositoryKey}}\n> Repository Root: {{repositoryRoot}}\n> Handoff Type: {{handoffType}}\n> Feature Branch: {{branch}}\n> ${kind === "fresh" ? "Approved" : "Retained"} Base SHA: {{baseSha}}\n> Branch Action: ${kind === "fresh" ? "create" : "select"}\n> Linked Branch State: ${kind === "fresh" ? "planned" : "materialized"}${kind === "amendment" ? "\n> Current Feature SHA: {{featureSha}}\n> Amendment Source Requirements Ref: {{amendmentSource}}\n> Amendment Tuple Approval Evidence: {{tupleApprovalEvidence}}\n> Amendment Immediate Reread SHA-256: {{immediateRereadSha256}}\n> Amendment Final Reread SHA-256: {{finalRereadSha256}}" : ""}\n\n## Handoff\nSynthetic scoped fixture, not execution permission.\n`;
}
export function producerFixture(kind: "fresh" | "amendment" = "fresh", ticket = "FIX-237") {
  const f = templateFixture(), originalEnvironment = process.env;
  process.env = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^(PA_|GIT_)/.test(key)) delete process.env[key];
  const repo = join(f.root, "repository"), userConfig = join(f.root, "user-config"), ai = join(f.root, "ai");
  mkdirSync(repo); mkdirSync(userConfig); mkdirSync(join(ai, "tickets"), { recursive: true });
  process.env.PA_PLATFORM_CONFIG = userConfig; process.env.PA_AI_USAGE_HOME = ai;
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git(["init", "-q", "-b", "develop"]); git(["config", "user.name", "Synthetic fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]); git(["config", "core.hooksPath", "/dev/null"]);
  writeFileSync(join(repo, "README"), "synthetic A"); git(["add", "README"]); git(["commit", "-qm", "synthetic base"]);
  const baseSha = git(["rev-parse", "HEAD"]);
  if (kind === "amendment") { writeFileSync(join(repo, "README"), "synthetic B"); git(["commit", "-qam", "synthetic feature"]); }
  const featureSha = git(["rev-parse", "HEAD"]);
  const branch = `feature/${ticket}-templates`, commentId = "c-20000101000000000", reviewRevision = "r001";
  writeFileSync(join(userConfig, "config.yaml"), `repos:\n  fixture-repo:\n    path: ${repo}\n    prefix: FIX\n    develop_branch: develop\n`);
  const handoffBindings = { ticket, repositoryKey: "fixture-repo", repositoryRoot: repo, handoffType: kind, branch, baseSha, ...(kind === "amendment" ? { featureSha, amendmentSource: "requirements:agent-teams/requirements/artifacts/synthetic-previous.md", tupleApprovalEvidence: `${ticket}#c-19990101000000000`, immediateRereadSha256: "d".repeat(64), finalRereadSha256: "e".repeat(64) } : {}) };
  const put = (id: string, source: string) => {
    const e = f.registry.entries.find(e => e.id === id)!; writeFileSync(join(f.root, e.source.path), source); e.source.sha256 = digest(source); e.capabilities.render = true; e.capabilities.validate = true; e.bindings = workflowProducerBindings(id)!;
    return f.save();
  };
  let selection = put(`handoff-${kind}`, handoffTemplate(kind));
  const handoff = templateService({ action: "render", id: `handoff-${kind}`, version: "1", bindings: handoffBindings }, { selection });
  if (!handoff.ok) throw new Error(JSON.stringify(handoff));
  const requirementsSource = "requirements:agent-teams/requirements/artifacts/synthetic.md";
  const requirementPath = join(ai, requirementsSource.slice("requirements:".length));
  const templateMatrix = parseReviewMatrixArtifact(readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url)), "requirements:agent-teams/requirements/artifacts/fixture-producer-node-pnpm.md").matrix;
  templateMatrix.source = requirementsSource; templateMatrix.repository = { key: "fixture-repo", root: repo, branch, baseSha };
  templateMatrix.environment.PA_TICKET_ID = { literal: ticket };
  for (const gate of templateMatrix.prerequisites) if (gate.kind === "operatorGate") gate.ticket = ticket;
  const matrixAuthority = `### Full Validation Matrix\n\nMatrix Source: ${requirementsSource}\n\n\`\`\`json\n${JSON.stringify(templateMatrix, null, 2)}\n\`\`\`\n\n`;
  const matrixSha256 = digest(matrixAuthority);
  const metadata = `> Review Revision: ${reviewRevision}\n> Review Approval Evidence: ${ticket}#${commentId}\n> Matrix Authority SHA-256: ${matrixSha256}\n> Matrix Approval Evidence: ${commentId}\n`;
  const preview = (handoff.candidate as string).replace("\n\n## Handoff", `\n${metadata}\n## Handoff`) + `\n${matrixAuthority}## After Matrix\nSynthetic fixture only.\n`;
  const requirementsPreviewPath = `agent-teams/requirements/artifacts/reviews/${ticket}/${reviewRevision}/requirements.md`;
  const uatPreviewPath = `agent-teams/requirements/artifacts/reviews/${ticket}/${reviewRevision}/uat-preview.md`;
  const uat = `# Synthetic UAT\n\n> Ticket: ${ticket}\n> Revision: ${reviewRevision}\n> Requirements: ${requirementsSource}\n\n## Scenarios\nNot executed.\n`;
  mkdirSync(dirname(join(ai, requirementsPreviewPath)), { recursive: true });
  writeFileSync(join(ai, requirementsPreviewPath), preview); writeFileSync(join(ai, uatPreviewPath), uat);
  writeFileSync(requirementPath, preview.replace("> Status: Draft", "> Status: Approved — synthetic fixture only"));
  const bindings = { ...handoffBindings, reviewRevision, requirementsSource, requirementsPreviewPath, requirementsPreviewSha256: digest(preview), uatPreviewPath, uatPreviewSha256: digest(uat), matrixSource: requirementsSource, matrixSha256 };
  selection = put("pair-signoff", pairTemplate);
  const request = { action: "render", id: "pair-signoff", version: "1", bindings };
  const pair = templateService(request, { selection }); if (!pair.ok) throw new Error(JSON.stringify(pair));
  const record = { id: ticket, project: "fixture-repo", title: "Synthetic fixture only", linkedBranches: [{ repo: "fixture-repo", branch, state: kind === "fresh" ? "planned" : "materialized", ...(kind === "amendment" ? { baseSha, headSha: featureSha } : {}), linkedAt: "2000-01-01T00:00:00.000Z", linkedBy: "synthetic" }],
    doc_refs: [{ type: "requirements", primary: true, path: requirementsSource.slice("requirements:".length) }], comments: [{ id: commentId, author: "sinh", content: pair.candidate as string, timestamp: "2000-01-01T00:00:00.000Z" }] };
  const ticketPath = join(ai, "tickets", `${ticket}.json`);
  const saveTicket = () => writeFileSync(ticketPath, JSON.stringify(record)); saveTicket();
  const resolveBaseline = (runGit?: (args: readonly string[], cwd: string) => string | Buffer) => resolveOrdinaryTaskBaseline({ canonicalRepoKey: "fixture-repo", canonicalRepoRoot: repo, ticketId: ticket, ticketStore: new TicketStore(join(ai, "tickets")), ...(runGit ? { runGit } : {}) });
  return { ...f, selection, bindings, handoffBindings, request, handoff, pair, record, ticketPath, requirementPath, preview, uat, ai, git, put, saveTicket, resolveBaseline,
    dispose: () => { process.env = originalEnvironment; f.dispose(); } };
}
