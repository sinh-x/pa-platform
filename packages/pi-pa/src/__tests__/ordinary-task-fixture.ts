import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Synthetic operator/task producer for disposable tests only. It is not a live
 * approval API, and is never used to modify a product or protected owner. */
export function seedOrdinaryTaskBaseline(input: { ai: string; repo: string; repoKey: string; ticket: string; branch: string; base: string }): string {
  const path = `agent-teams/requirements/artifacts/${input.ticket}-ordinary.md`;
  const id = "c-20261026000000268";
  const content = `# Disposable task\n\n> Status: Approved — fixture plan only\n> Author: requirements/analyst\n> Ticket: ${input.ticket}\n> Repository Key: ${input.repoKey}\n> Repository Root: ${input.repo}\n> Handoff Type: fresh\n> Approved Base SHA: ${input.base}\n> Feature Branch: ${input.branch}\n> Review Approval Evidence: ${input.ticket}#${id}\n\n## Work\nIsolated ordinary task; no installed qualification.\n`;
  mkdirSync(join(input.ai, "agent-teams/requirements/artifacts"), { recursive: true });
  writeFileSync(join(input.ai, path), content);
  const ticketPath = join(input.ai, "tickets", `${input.ticket}.json`);
  const ticket = JSON.parse(readFileSync(ticketPath, "utf8"));
  ticket.doc_refs = [...(ticket.doc_refs ?? []).map((ref: Record<string, unknown>) => ({ ...ref, primary: false })), { type: "requirements", path, primary: true }];
  ticket.comments = [...(ticket.comments ?? []), { id, author: "sinh", timestamp: "2026-10-26T00:00:00.000Z", content: `Approve ${input.ticket} ${input.repoKey} ${input.repo} ${input.branch} exact base ${input.base}; source requirements:${path}.` }];
  writeFileSync(ticketPath, JSON.stringify(ticket));
  return join(input.ai, path);
}
