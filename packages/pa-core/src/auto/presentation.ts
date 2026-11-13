import { AUTO_REASON_TEXT, AutoWaitlistError, type AutoWaitlistEntry } from "./waitlist.js";
import type { AutoWaitlistView } from "./store.js";

export const AUTO_PAGE_SIZE = 100;
export type AutoSection = "candidates" | "excluded" | "all";
export function autoWaitlistPage(view: AutoWaitlistView, page = 1, section: AutoSection = "candidates") {
  if (!Number.isSafeInteger(page) || page < 1 || !["candidates", "excluded", "all"].includes(section)) throw new AutoWaitlistError("AUTO_INPUT");
  const rows = (view.state?.snapshot?.entries ?? []).filter(e => section === "all" || (section === "candidates" ? e.route !== "observe" : e.route === "observe"));
  const pages = Math.max(1, Math.ceil(rows.length / AUTO_PAGE_SIZE));
  if (page > pages) throw new AutoWaitlistError("AUTO_INPUT");
  return { section, page, pages, total: rows.length, entries: rows.slice((page - 1) * AUTO_PAGE_SIZE, page * AUTO_PAGE_SIZE), nextPage: page < pages ? page + 1 : null };
}
export const AUTO_NEXT_ACTION: Readonly<Record<AutoWaitlistEntry["route"], string>> = Object.freeze({
  draft: "Prepare unsigned requirements/UAT only", "review-package": "Review the existing exact package",
  "review-start": "Review a separate implementation-start intent", observe: "Inspect through the original owner",
});
/** Pure known-text diagnostic; never probes, launches or reflects exceptions. */
export function autoWaitlistDiagnostic(code: AutoWaitlistError["code"]): string {
  const reasons: Record<AutoWaitlistError["code"], string> = {
    AUTO_INPUT: "The command or page is unsupported. No selection or approval was made.",
    AUTO_SOURCE: "Required registered-project, ticket, bulletin, document or registry observations could not be completed. A retained snapshot is not a fresh empty list.",
    AUTO_LIMIT: "The bounded scan or snapshot exceeded its limit; a complete fresh waitlist is unavailable.",
    AUTO_STORE: "The coordination snapshot could not be safely read or saved. Existing state may remain; no product work is requested by this command.",
    AUTO_BUSY: "Another scan is active or its original outcome is unsettled. The retained snapshot must not be treated as newly observed.",
    AUTO_UNAVAILABLE: "The requested action lacks compatible paired support or admitted native owner evidence. The original item is retained; no fallback authority is inferred.",
  };
  const safeCode = typeof code === "string" && Object.hasOwn(reasons, code) ? code : "AUTO_STORE";
  return `Auto action not completed; no automatic work was requested.\nCondition: The requested auto action is blocked.\nSource: PPA auto coordination check (${safeCode}).\nReason: ${reasons[safeCode]}\nCorrection: Inspect ppa auto status and ppa auto --help, then ask the runtime/config owner about unresolved evidence. Impact: read-only for inspection, none for asking. Actor: operator. New approval: not required to inspect or ask; repairs need their owner. Prerequisite: preserve the existing snapshot and original owner evidence.\nResume Action: Repeat read-only inspection after the owner establishes support or fresh observations. Do not clear evidence, repeat approvals or launch a replacement worker to hide uncertainty.`;
}
export function formatAutoWaitlist(view: AutoWaitlistView, page = 1, section: AutoSection = "candidates"): string {
  const s = view.state?.snapshot, result = autoWaitlistPage(view, page, section);
  const lines = ["PPA auto waitlist — this list does not select, approve or execute work.",
    `PAP/PAPC waitlist: ${view.freshness}. Observed: ${s?.observedAt ?? "no complete snapshot"}.`,
    "Nothing starts from a recommendation or this list. No approval has been requested."];
  if (view.state?.lastAttempt.outcome === "failed") lines.push("Warning: the latest scan failed. Any retained entries are stale; inspect the original source owners.");
  if (view.scan === "busy-or-unsettled") lines.push("Warning: a scan is active or unsettled. This is the retained list, not a completed refresh.");
  if (!s) { lines.push("No complete waitlist is available. Use ppa auto scan to request a read-only refresh."); return lines.join("\n"); }
  const candidates = s.entries.filter(e => e.route !== "observe").length;
  lines.push(`Candidates: ${candidates}. Blocked/excluded: ${s.entries.length - candidates}. Use --section excluded to inspect reasons.`,
    "Display order: priority, oldest creation time, then ID; this is not an execution order.",
    `Recommendation: ${s.recommendation ?? "none"} (first candidate in that display order; no deadline inferred).`,
    `${section} — page ${result.page}/${result.pages}, ${result.total} entries`);
  for (const e of result.entries) {
    lines.push(`${e.id} | ${e.project} | ${e.priority} | ${e.status} | ${e.title}`,
      `  Next: ${AUTO_NEXT_ACTION[e.route]}.`, ...e.reasons.map(reason => `  Reason: ${AUTO_REASON_TEXT[reason]}`));
    if (e.unresolvedDependencies.length) lines.push(`  Dependencies: ${e.unresolvedDependencies.join(", ")}`);
    if (e.blockingBulletins.length) lines.push(`  Bulletins: ${e.blockingBulletins.join(", ")}`);
    if (e.competingDeployments.length) lines.push(`  Original deployments: ${e.competingDeployments.join(", ")}`);
    if (e.documents.subjectSha256) lines.push(`  Package: ${e.documents.packageId} r${e.documents.revision}; SHA-256 ${e.documents.subjectSha256}`);
    if (e.documents.decisionId) lines.push(`  Document decision: ${e.documents.decisionId} (not implementation-start permission)`);
  }
  if (!result.total) lines.push("No entries in this section. No action is required; other sections remain available.");
  if (result.nextPage) lines.push(`Next page: ppa auto list --section ${section} --page ${result.nextPage}`);
  return lines.join("\n");
}
