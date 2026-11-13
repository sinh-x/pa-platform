import {
  AutoCoordinator, AutoWaitlistError, AutoWaitlistStore, RegistryAutoJournal, RegistryDocumentJournal, RegistryAutoNotifications,
  getDb, openReadonlyRegistryDatabase, scanAutoWaitlist, formatAutoWaitlist, autoWaitlistDiagnostic,
  resolveRepoExecutionPath, type AutoControl, type AutoItem,
} from "@pa-platform/pa-core";
import { autoDraftOwner } from "./auto-draft.js";
import { runPiAutoScanWorker } from "./auto-scan-client.js";
import { nativeAutoTerminal, type AutoTerminal } from "./auto-terminal.js";

export function readAutoCoordination() {
  try {
    const db = openReadonlyRegistryDatabase(true);
    try { const journal = new RegistryAutoJournal(db); return { observed: true, active: journal.active(), control: journal.control(), notification: new RegistryAutoNotifications(db).last() }; }
    finally { db.close(); }
  } catch { return { observed: false, active: null, control: null, notification: null }; }
}
export interface AutoForegroundHooks {
  review?(item: AutoItem, journal: RegistryAutoJournal, terminal: AutoTerminal): Promise<AutoItem>;
  reconcile?(item: AutoItem, journal: RegistryAutoJournal, terminal: AutoTerminal): Promise<AutoItem>;
  enable?(journal: RegistryAutoJournal, terminal: AutoTerminal): Promise<void>;
  close?(item: AutoItem, journal: RegistryAutoJournal, terminal: AutoTerminal): Promise<AutoItem>;
  revise?(item: AutoItem, journal: RegistryAutoJournal, terminal: AutoTerminal): Promise<AutoItem>;
  changed?(journal: RegistryAutoJournal): void;
}
/** Human-only selection/control. JSON/noninteractive calls have no selection or
 * decision flags. Native owners are callbacks, never public request fields. */
export async function runAutoForeground(terminal: AutoTerminal = nativeAutoTerminal(), hooks: AutoForegroundHooks = {}): Promise<number> {
  try {
    terminal.authenticate();
    const snapshots = new AutoWaitlistStore(), view = snapshots.scan(runPiAutoScanWorker);
    terminal.display(formatAutoWaitlist(view));
    const journal = new RegistryAutoJournal(getDb()), coordinator = new AutoCoordinator(journal, () => terminal.authenticate());
    let active = journal.active();
    if (!active) {
      if (view.freshness !== "fresh" || !view.state?.snapshot) throw new AutoWaitlistError("AUTO_SOURCE");
      const candidates = view.state.snapshot.entries.filter(e => e.route !== "observe");
      if (!candidates.length) return 0;
      let page = 0;
      while (!active) {
        const rows = candidates.slice(page * 100, (page + 1) * 100), next = (page + 1) * 100 < candidates.length;
        const choices = [...rows.map(e => `${e.id}: ${e.title} (${e.route}; selection is not implementation approval)`), ...(next ? ["Next 100 candidates"] : []), ...(page ? ["Previous 100 candidates"] : [])];
        const selection = await terminal.choose(`Choose ONE item, page ${page + 1}. No default or timeout starts work.`, choices);
        if (selection < 0) return 0;
        if (selection >= rows.length) { page += selection === rows.length && next ? 1 : -1; continue; }
        const entry = rows[selection]!, repository = resolveRepoExecutionPath(entry.project);
        const snapshotRoot = view.state.snapshot.projects.find(p => p.key === entry.project)?.canonicalRoot;
        if (repository.repoRoot !== snapshotRoot) throw new AutoWaitlistError("AUTO_SOURCE");
        active = journal.select(entry, repository.repoRoot, () => {
          const found = runPiAutoScanWorker().entries.find(e => e.id === entry.id);
          if (!found) throw new AutoWaitlistError("AUTO_SOURCE"); return found;
        }, () => terminal.authenticate());
      }
      if (active.route === "draft") {
        try { active = await coordinator.draft(active, autoDraftOwner(journal, () => terminal.authenticate())); }
        catch { active = journal.change(active.itemId, journal.item(active.itemId).revision, b => ({ ...b, state: "blocked", reason: "contract" }), () => terminal.authenticate()); }
      }
    }
    hooks.changed?.(journal);
    terminal.display(`Active item ${active.ticket}: ${active.state}. Original item ${active.itemId}.\nThis item holds the single PAP/PAPC slot until an explicitly settled disposition.`);
    const selected = await terminal.choose("Inspect or control the original item; cancellation grants nothing and retains the slot.", [
      "Inspect full frozen documents", "Review exact implementation start", "Reconcile original work (never launch a replacement)",
      "Pause scanning and new dispatch (does not kill a worker)", "Enable/resume compatible new work", "Decline before implementation / safely close settled item", "Request changes / withdraw a never-dispatched start proposal",
    ]);
    if (selected === 0 && active.subjectSha256) {
      const documents = new RegistryDocumentJournal(journal.db), subject = documents.subject(active.subjectSha256);
      for (const member of subject.members) {
        if (!member.mediaType.startsWith("text/")) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
        terminal.display(`${member.role} (${member.sha256})\n${new TextDecoder("utf-8", { fatal: true }).decode(documents.snapshot(member.sha256))}`);
      }
    } else if (selected === 1) {
      if (!hooks.review) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      active = await hooks.review(active, journal, terminal);
    } else if (selected === 2) {
      if (active.dispatch) {
        if (!hooks.reconcile) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
        active = await hooks.reconcile(active, journal, terminal);
      } else if (active.draft) active = await coordinator.reconcile(active, autoDraftOwner(journal, () => terminal.authenticate()), "draft");
      else if (active.route === "draft") active = await coordinator.draft(active, autoDraftOwner(journal, () => terminal.authenticate()));
    } else if (selected === 3) {
      const before = journal.control(); journal.setControl(before.revision, { scansEnabled: false, dispatchEnabled: false, paused: true }, () => terminal.authenticate());
      terminal.display("New scans/dispatch paused. Existing work was not killed; its original item and evidence remain.");
    } else if (selected === 4) {
      if (!hooks.enable) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); await hooks.enable(journal, terminal);
    } else if (selected === 5) {
      // Only never-started/no-effect selections can be declined here. Work that
      // ran requires explicit original-owner settlement through reconciliation.
      if (active.draft || active.dispatch || active.decisionId) {
        if (!hooks.close) throw new AutoWaitlistError("AUTO_BUSY");
        active = await hooks.close(active, journal, terminal);
      } else {
      if (await terminal.choose("Decline this service proposal only? The underlying ticket and documents will not be rejected or deleted.", ["Decline this never-started proposal"]) === 0) {
        active = coordinator.close(active, "declined", () => terminal.authenticate());
      }
      }
    } else if (selected === 6) {
      if (!hooks.revise) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      active = await hooks.revise(active, journal, terminal);
    }
    hooks.changed?.(journal);
    terminal.display(`Item ${active.ticket}: ${active.state}. Run ppa auto to inspect/resume the same item. No product completion or human UAT is asserted.`);
    return 0;
  } catch {
    const diagnostic = autoWaitlistDiagnostic("AUTO_UNAVAILABLE");
    try { terminal.display(diagnostic); } catch { process.stderr.write(`${diagnostic}\n`); }
    return 1;
  }
}
