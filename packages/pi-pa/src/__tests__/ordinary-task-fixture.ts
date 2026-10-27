import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowDigest } from "@pa-platform/pa-core";

/** Synthetic operator/task producer for disposable tests only. It is not a live
 * approval API, and is never used to modify a product or protected owner. */
export function seedOrdinaryTaskBaseline(input: { ai: string; repo: string; repoKey: string; ticket: string; branch: string; base: string; producer?: "waw" | "ttl012" | "ttl014" }): string {
  const path = `agent-teams/requirements/artifacts/${input.ticket}-ordinary.md`;
  const id = "c-20261026000000268";
  const content = `# Disposable task\n\n> Status: Approved — fixture plan only\n> Author: requirements/analyst\n> Ticket: ${input.ticket}\n> Repository Key: ${input.repoKey}\n> Repository Root: ${input.repo}\n> Handoff Type: fresh\n> Approved Base SHA: ${input.base}\n> Feature Branch: ${input.branch}\n> Review Approval Evidence: ${input.ticket}#${id}\n\n## Work\nIsolated ordinary task; no installed qualification.\n`;
  mkdirSync(join(input.ai, "agent-teams/requirements/artifacts"), { recursive: true });
  writeFileSync(join(input.ai, path), content);
  const ticketPath = join(input.ai, "tickets", `${input.ticket}.json`);
  const ticket = JSON.parse(readFileSync(ticketPath, "utf8"));
  ticket.doc_refs = [...(ticket.doc_refs ?? []).map((ref: Record<string, unknown>) => ({ ...ref, primary: false })), { type: "requirements", path, primary: true }];
  ticket.comments = [...(ticket.comments ?? []), { id, author: "sinh", timestamp: "2026-10-26T00:00:00.000Z", content: `Approve ${input.ticket} ${input.repoKey} ${input.repo} ${input.branch} exact base ${input.base}; source requirements:${path}.` }];
  if (input.producer) {
    const revision = "r001", source = `requirements:${path}`;
    const current = content.replace("> Status:", `> Review Revision: ${revision}\n> Status:`);
    const preview = current.replace("Approved — fixture plan only", "Draft — UNAPPROVED");
    const previewPath = `agent-teams/requirements/artifacts/reviews/${input.ticket}/${revision}/requirements.md`;
    mkdirSync(join(input.ai, `agent-teams/requirements/artifacts/reviews/${input.ticket}/${revision}`), { recursive: true });
    writeFileSync(join(input.ai, previewPath), preview); writeFileSync(join(input.ai, path), current);
    const hash = workflowDigest(preview);
    ticket.comments.at(-1).content = input.producer === "waw"
      ? `Explicit PA sign-off from interactive deployment d-123abc: Approve ${revision} pair and exact matrix. I approve the complete ${input.ticket} requirements revision ${revision} and companion UAT, local scope. Reviewed requirements: ${previewPath}, raw SHA-256 ${hash}. Handoff Type: fresh. Repository Key: ${input.repoKey}. Repository Root: ${input.repo}. Feature Branch: ${input.branch}. Approved Base SHA: ${input.base}. Matrix Source: ${source}. This is not implementation authorization, AWS access/apply/rollout/backfill/Billing authorization, paired-runtime readiness, or successful UAT.`
      : input.producer === "ttl012"
        ? `APPROVED in standalone PA sign-off, deployment d-123abc: complete requirements/UAT pair ${revision}. Requirements source ${source} reviewed as reviews/${input.ticket}/${revision}/requirements.md raw SHA-256 ${hash}. Intent: local scope. Handoff fresh, canonical ${input.repoKey} root ${input.repo}, approved base ${input.base}, exact branch ${input.branch}, planned/create. Matrix Source: ${source}. Device tests, candidate CI, human UAT and authenticated runtime/preparation readiness remain separate gates no implementation spawn authorized.`
        : `Final standalone PA sign-off in d-123abc. Sinh selected Approve exact ${revision} pair and matrix after complete whole-document Markdown requirements and sixteen-scenario UAT review was offered. Approved intent: local scope. Requirements Source and Matrix Source ${source}. Reviewed revision ${revision} requirements raw SHA-256 ${hash}. Repository Key ${input.repoKey} Repository Root ${input.repo} Ticket ${input.ticket} Route builder/orchestrator Handoff Type fresh Feature Branch ${input.branch} Approved Base SHA ${input.base} Linked Branch State planned Branch Action create. No source implementation, live service/network/certificate/phone effect, matrix execution, review/builder spawn, merge or checkout return is authorized. Plan approval is not executed UAT or application acceptance.`;
  }
  writeFileSync(ticketPath, JSON.stringify(ticket));
  return join(input.ai, path);
}

/** A pinned harness with mutable fixture data, never a mutable package-script
 * command grant. The real Node processes run through the v1 namespace profile. */
export function seedOrdinaryCommandFixture(repo: string): string {
  const script = `const fs=require('node:fs');\nconst data=JSON.parse(fs.readFileSync('package.json','utf8'));\nif(process.argv[2]==='typecheck'){console.log('ordinary-private-token');console.error('actual ordinary stderr');process.exit(data.fixtureExit??0);}\nconst text=fs.readFileSync('README.md','utf8');console.log('fixture whitespace check');process.exit(/[ \\t]+$/m.test(text)?2:0);\n`;
  writeFileSync(join(repo, "ordinary-check.cjs"), script);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "ordinary-fixture", fixtureExit: 0 }));
  const manifest = JSON.stringify({ schemaVersion: "project-command-contract/v1", effects: ["project-read", "isolated-temp-write"], checks: ["typecheck", "diff-check"].map((id) => ({
    id, executable: realpathSync(process.execPath), argv: ["ordinary-check.cjs", id], environment: {}, readPaths: ["README.md", "package.json"],
    prerequisites: [{ path: "ordinary-check.cjs", sha256: workflowDigest(script) }], timeoutSeconds: 30, maximumOutputBytes: 1048576,
  })) });
  writeFileSync(join(repo, "ordinary-checks.json"), manifest);
  return `    projectCommands:\n      manifest: ordinary-checks.json\n      sha256: ${workflowDigest(manifest)}\n`;
}
