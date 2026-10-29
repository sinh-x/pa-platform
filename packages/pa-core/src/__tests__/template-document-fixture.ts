// Synthetic structural data only. Not canonical prose, checked facts or approvals.
import { readFileSync } from "node:fs";
import { parseReviewMatrixArtifact } from "../validation/review-contract.js";
import { DOCUMENT_PROFILES } from "../templates/document-profiles.js";
import { digest, type TemplateId } from "../templates/schema.js";
const scenario = "### TS-1: Synthetic scenario\r\n- Acceptance Criterion: AC-1\r\n- Preconditions: Isolated fixture.\r\n- Steps:\r\n  1. Inspect synthetic fixture.\r\n- Expected Result: Documented observation.\r\n- Actual Result: Not run.\r\n- Status: Not run.\r\n";
export function documentFixture(id: TemplateId, ticket = "FIX-1"): { source: string; sections: string[] } {
  const profile = DOCUMENT_PROFILES[id]; if (!profile) throw new Error("not a document fixture");
  const numbered = ["requirements", "project-agent-guide", "spike-full-requirements"].includes(id);
  let sections = Array.from({ length: profile.minimumSections }, (_, i) => numbered ? `## ${i + 1}. Synthetic fixture` : `## Synthetic ${i + 1}`);
  if (id === "implementation-phase-report") sections = ["## Identity/outcome", "## Outcome first", "## Change view", "## Checks", "## Challenges/recovery", "## Risks/next action", "## Learning", "## Provenance/delivery"];
  if (id === "uat-review") sections = ["## What Was Built", "## Test Scenarios", "## Regression Checks", "## Edge Cases", "## Known Caveats", "## UAT Sign-Off"];
  if (id === "uat-plan") sections = ["## System Type", "## Preconditions", "## Test Scenarios", "## Regression Checks", "## Edge Cases", "## UAT Sign-Off"];
  sections.push("## Body");
  const source = "requirements:agent-teams/requirements/artifacts/synthetic-document.md";
  const matrix = parseReviewMatrixArtifact(readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url)), "requirements:agent-teams/requirements/artifacts/fixture-producer-node-pnpm.md").matrix;
  matrix.source = source; matrix.repository.branch = `feature/${ticket}-fixture`; matrix.environment.PA_TICKET_ID = { literal: ticket };
  for (const gate of matrix.prerequisites) if (gate.kind === "operatorGate") gate.ticket = ticket;
  const authority = `### Full Validation Matrix\r\n\r\nMatrix Source: ${source}\r\n\r\n\`\`\`json\r\n${JSON.stringify(matrix, null, 2).replaceAll("\n", "\r\n")}\r\n\`\`\`\r\n\r\n`;
  const metadata: Record<string, string> = { Ticket: "{{ticket}}", "Repository Key": "fixture-repo", "Repository Root": "/fixture/canonical", Class: "software-dev", Route: "builder/orchestrator", Status: "Draft", "Handoff Type": "fresh", "Feature Branch": "feature/{{ticket}}-fixture", "Matrix Authority SHA-256": digest(authority + "\r\n"), "Review Revision": "r001", Requirements: source, Implementation: "Not implemented - draft", "Execution Model": "direct-phase", Version: "1", Repository: "/fixture/canonical", Date: "2000-01-01", Deployment: "d-000001", Revision: "r001", "Acceptance Criteria": '["AC-1"]' };
  const frontmatter = id === "spike-learning-note" ? "---\r\ntype: spike-research\r\nstatus: draft\r\nsource_doc: synthetic.md\r\nsource_repo: fixture\r\nsource_ticket: FIX-1\r\nsource_deployments:\r\n  - d-000001\r\n---\r\n" : "";
  let body = `${frontmatter}# Synthetic fixture\r\n\r\n${profile.headers.map(label => `> ${label}: ${metadata[label]}\r\n`).join("")}${id === "requirements" ? `> Approved Base SHA: ${"a".repeat(40)}\r\n` : ""}\r\n`;
  for (const [i, heading] of sections.entries()) {
    body += `${heading}\r\n`;
    if (heading === "## Body") body += "{{ticket}}\r\n";
    else if (heading === "## Checks") body += "| Order | Exact command | Candidate | Exit or unknown | Evidence |\r\n|---|---|---|---|---|\r\n| 1 | synthetic only | unknown | Not run | none |\r\n";
    else if (heading === "## Test Scenarios") body += scenario;
    else if (id === "requirements" && (i === 5 || i === 6)) body += `| ID | Requirement |\r\n|---|---|\r\n| ${i === 5 ? "FR" : "NFR"}-1 | Synthetic requirement. |\r\n`;
    else if (id === "requirements" && i === 9) body += "- [ ] AC-1: Synthetic acceptance criterion.\r\n";
    else if (id === "requirements" && i === 11) body += authority;
    else body += "Synthetic structural content; not independently verified.\r\n";
    body += "\r\n";
  }
  return { source: body.slice(0, -2), sections };
}
