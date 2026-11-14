import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import {
  AutoWaitlistError, RegistryAutoShortlists, RegistryAutoDrafts, getDb, openReadonlyRegistryDatabase, RegistryReadError, readProcessFingerprint, workflowDigest,
  type AutoItem, type AutoPublishedShortlist,
} from "@pa-platform/pa-core";
import { PiAutoReasoningOwner, type PiAutoReasoningDependencies } from "./auto-reasoning.js";
import { nativeAutoTerminal, type AutoTerminal } from "./auto-terminal.js";
import { selectedPiAutoShortlistPair } from "./auto-shortlist-contract.js";

export const AUTO_SHORTLIST_USAGE = `Pi-only: ppa auto shortlist [--json] [--view UUID] [--section candidates|excluded|all] [--page N]
  ppa auto shortlist --help
  In an unmanaged terminal: refresh through the exact selected reasoning pair,
  inspect up to ten recommendations, then explicitly choose ONE ticket or Cancel.
  Noninteractive / --json: read saved reports and original choice/item state only.
  Recommendations never select work. This new route does not widen manual v1 receipts.
  After a choice, native delegated admission is required; final review stays human.
  No service installation, policy adoption or activation is performed by this command.`;
export function autoShortlistDiagnostic(input: "AUTO_SOURCE" | "AUTO_BUSY" | "AUTO_UNAVAILABLE" = "AUTO_UNAVAILABLE"): string {
  const code = input === "AUTO_SOURCE" || input === "AUTO_BUSY" ? input : "AUTO_UNAVAILABLE";
  const reason = code === "AUTO_BUSY" ? "Original reasoning, choice or selected work holds coordination; no replacement is admitted."
    : code === "AUTO_SOURCE" ? "Current report, source or native evidence could not be verified; the original evidence remains."
      : "The required exact pairing or native effect owner is not admitted. Existing manual receipts grant no delegated effects.";
  return `Shortlist work cannot continue through this request.\n\nCondition: The next native stage is blocked; any saved original item or interaction remains.\nSource: PPA shortlist and effect owners (${code}).\nReason: ${reason}\nCorrection: Inspect ppa auto shortlist --json and ask the named runtime/configuration owner to reconcile the original evidence. Impact: read-only for inspection, none for asking. Actor: operator or agent. New approval: not required to inspect or ask; repairs need their owner. Prerequisite: preserve original IDs and supported PPA inspection.\nResume Action: Continue the SAME original operation only after its owner establishes current compatible evidence and authority. Do not infer cleanup, repeat an unknown choice or start a replacement worker.`;
}
function displayShortlist(terminal: AutoTerminal, saved: AutoPublishedShortlist): void {
  terminal.display(`Shortlist saved: ${saved.report.assessment.shortlist.length} suitable tickets. No ticket selected.\nView ${saved.version}; SHA-256 ${saved.sha256}.\nNative report SHA-256 ${saved.reportSha256}; reasoning cycle ${saved.cycleId}; session ${saved.report.session.deploymentId}.\nFull scan/exclusions SHA-256 ${saved.report.snapshotSha256}; goal evidence SHA-256 ${saved.report.goalEvidenceSha256}.`);
  for (const row of saved.report.assessment.shortlist) {
    const rationale = saved.report.assessment.assessments.find(a => a.ticket === row.ticket)!.rationale;
    terminal.display(`${row.ticket} — recommendation only\nGoal fit: ${row.goalAlignment}\nRationale: ${rationale}\nBounded outcome: ${row.boundedOutcome}\nStage / next route: ${row.stage} / ${row.nextRoute}\nAlternatives: ${row.alternatives}\nRisk / dependencies: ${row.risksAndDependencies}\nVerification: ${row.verification}`);
  }
  terminal.display(`Advisory ranking: ${saved.report.assessment.rankingRationale}\n${saved.report.assessment.summary}`);
}
export interface AutoShortlistForegroundDependencies extends PiAutoReasoningDependencies {
  store?: RegistryAutoShortlists;
  owner?: PiAutoReasoningOwner;
  /** Genuine policy/intent/admission owner only; NOT legacy per-ticket review. */
  continueSelected?(item: AutoItem, store: RegistryAutoShortlists, terminal: AutoTerminal): Promise<void>;
}
export async function runAutoShortlistForeground(terminal: AutoTerminal = nativeAutoTerminal(), deps: AutoShortlistForegroundDependencies = {}): Promise<number> {
  try {
    terminal.authenticate();
    if (!deps.store) (deps.pair ?? selectedPiAutoShortlistPair)().assertCurrent();
    const store = deps.store ?? new RegistryAutoShortlists(getDb());
    const identity = () => {
      terminal.authenticate(); const fp = readProcessFingerprint(process.pid);
      if (!fp) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      return workflowDigest(JSON.stringify(["ppa-auto-shortlist-foreground/v1", userInfo().uid, fp]));
    };
    const owner = deps.owner ?? new PiAutoReasoningOwner(store, identity, deps);
    const existing = store.items.active();
    if (existing) {
      terminal.display(`Original selected item ${existing.ticket}: ${existing.state}. No new shortlist or replacement work requested.`);
      if (!store.selectionForItem(existing.itemId)) throw new AutoWaitlistError("AUTO_BUSY");
      if (!deps.continueSelected) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      await deps.continueSelected(existing, store, terminal); return 0;
    }
    const pending = store.pendingChoice();
    if (pending) {
      const result = store.reconcileChoice(pending.requestId, owner.host);
      if (result.state !== "accepted" || !result.itemId) throw new AutoWaitlistError("AUTO_BUSY");
      if (!deps.continueSelected) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      await deps.continueSelected(store.items.item(result.itemId), store, terminal); return 0;
    }
    const saved = await owner.refresh();
    if (!saved) throw new AutoWaitlistError("AUTO_SOURCE");
    displayShortlist(terminal, saved);
    if (!saved.report.assessment.shortlist.length) {
      terminal.display("No suitable ticket is shortlisted. No drafting or implementation requested; inspect the full saved scan and goal evidence."); return 0;
    }
    const choice = await store.choose(saved.version, { ...owner.host, authenticate: identity, capture: async (request, shortlist) => {
      const rows = shortlist.report.assessment.shortlist;
      const selected = await terminal.choose("Choose ONE exact shortlisted ticket, including a non-top recommendation, or Cancel. Your choice is task intent, not policy adoption or a start approval.", rows.map(row => row.ticket));
      terminal.authenticate(); const ticket = rows[selected]?.ticket ?? null, principal = `local-uid:${userInfo().uid}`, interactionId = `interaction-${randomUUID()}`;
      return { ticket, principal, interactionId, evidence: Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-shortlist-human-choice/v1", method: "ppa-auto-foreground", requestId: request.requestId,
        viewVersion: shortlist.version, viewSha256: shortlist.sha256, ticket, principal, interactionId })) };
    } });
    if (choice.state === "cancelled") { terminal.display("Ticket choice cancelled. No item was selected; recommendations remain available."); return 0; }
    if (choice.state !== "accepted" || !choice.itemId) throw new AutoWaitlistError("AUTO_SOURCE");
    terminal.display(`Selected ${choice.ticket}; original choice ${choice.requestId}. Native policy and admission checks are next; no worker is confirmed by selection.`);
    if (!deps.continueSelected) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    await deps.continueSelected(store.items.item(choice.itemId), store, terminal); return 0;
  } catch (error) {
    let code: "AUTO_SOURCE" | "AUTO_BUSY" | "AUTO_UNAVAILABLE" = "AUTO_UNAVAILABLE";
    try {
      const descriptor = error instanceof AutoWaitlistError ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
      if (descriptor && "value" in descriptor && (descriptor.value === "AUTO_SOURCE" || descriptor.value === "AUTO_BUSY")) code = descriptor.value;
    } catch { /* Unknown/hostile exceptions never become public causes. */ }
    const message = autoShortlistDiagnostic(code);
    try { terminal.display(message); } catch { process.stderr.write(`${message}\n`); } return 1;
  }
}
/** Existing-only reader: no initialization, migration, source scan or inference. */
export function readAutoShortlistStatus(query: { viewVersion?: string; page?: number; section?: "candidates" | "excluded" | "all" } = {}) {
  try {
    const db = openReadonlyRegistryDatabase(true);
    try {
      const store = new RegistryAutoShortlists(db), active = store.items.active(), shortlist = query.viewVersion ? store.published(query.viewVersion) : store.head();
      const snapshot = shortlist ? store.snapshot(store.cycle(shortlist.cycleId)) : null, page = query.page ?? 1, section = query.section ?? "all";
      if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new AutoWaitlistError("AUTO_INPUT");
      const entries = snapshot?.entries.filter(e => section === "all" || (section === "excluded" ? e.route === "observe" : e.route !== "observe")) ?? [];
      const view = shortlist ? JSON.parse(shortlist.view.toString("utf8")) : null, latest = store.latestCycle();
      const freshness = !shortlist ? "missing" : latest?.cycleId !== shortlist.cycleId || store.activeCycle() ? "held-or-stale"
        : Date.now() >= Date.parse(view.generatedAt) && Date.now() < Date.parse(view.expiresAt) ? "time-current" : "expired";
      return { schemaVersion: "pa-auto-shortlist-result/v1", observed: true, freshness, materialFreshness: "not-rechecked", shortlist: shortlist ? { version: shortlist.version, sha256: shortlist.sha256, reportSha256: shortlist.reportSha256, report: shortlist.report, view: JSON.parse(shortlist.view.toString("utf8")) } : null,
        inventory: { snapshotSha256: shortlist?.report.snapshotSha256 ?? null, section, page, pageSize: 100, total: entries.length, pages: Math.ceil(entries.length / 100), entries: entries.slice((page - 1) * 100, page * 100) },
        reasoning: store.activeCycle(), pendingChoice: store.pendingChoice(), activeItem: active, draftGeneration: active ? new RegistryAutoDrafts(store.items).current(active.itemId) : null, selection: active ? store.selectionForItem(active.itemId) : null,
        executionRequested: false, authorityGranted: false };
    } finally { db.close(); }
  } catch (error) {
    return { schemaVersion: "pa-auto-shortlist-result/v1", observed: false, reason: error instanceof RegistryReadError && error.reason === "registry-missing" ? "not-initialized" : "unavailable", executionRequested: false, authorityGranted: false };
  }
}
export function runAutoShortlistReadCommand(args: string[], io: { stdout(text: string): void; stderr(text: string): void }): number {
  if (args.length === 1 && args[0] === "--help") { io.stdout(AUTO_SHORTLIST_USAGE); return 0; }
  const json = args.includes("--json");
  try {
    if (args.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 65_536) throw new AutoWaitlistError("AUTO_INPUT");
    const query: Parameters<typeof readAutoShortlistStatus>[0] = {}, seen = new Set<string>(), rest = [...args];
    while (rest.length) {
      const flag = rest.shift()!; if (seen.has(flag)) throw new AutoWaitlistError("AUTO_INPUT"); seen.add(flag);
      if (flag === "--json") continue;
      const value = rest.shift();
      if (flag === "--page" && value && /^[1-9]\d{0,5}$/.test(value)) query.page = Number(value);
      else if (flag === "--section" && ["all", "candidates", "excluded"].includes(value ?? "")) query.section = value as "all" | "candidates" | "excluded";
      else if (flag === "--view" && value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) query.viewVersion = value;
      else throw new AutoWaitlistError("AUTO_INPUT");
    }
    const state = readAutoShortlistStatus(query);
    if (json) io.stdout(JSON.stringify(state));
    else if (state.observed && state.inventory) {
      io.stdout(`Saved shortlist: ${state.shortlist?.report.assessment.shortlist.length ?? 0} recommendations; view ${state.shortlist?.version ?? "none"}; ${state.freshness}.\nMaterial source/authority freshness was not rechecked by this reader.\n${state.activeItem ? `Original item ${state.activeItem.ticket}: ${state.activeItem.state}.` : state.pendingChoice ? "Original human-choice outcome remains to be reconciled; no replacement choice is allowed." : "No ticket selected."}\nInventory ${state.inventory.section}, page ${state.inventory.page}/${Math.max(1, state.inventory.pages)}; ${state.inventory.total} entries.\n${state.inventory.entries.map(e => `${e.id}: ${e.title} (${e.route}; ${e.reasons.join(", ")})`).join("\n")}\nUse --json for full saved recommendations/report and original operation IDs. No effect was requested.`);
    } else io.stderr(autoShortlistDiagnostic());
    return state.observed ? 0 : 1;
  } catch {
    if (json) io.stdout(JSON.stringify({ schemaVersion: "pa-auto-shortlist-result/v1", ok: false, code: "AUTO_INPUT", executionRequested: false }));
    else io.stderr(autoShortlistDiagnostic()); return 1;
  }
}
