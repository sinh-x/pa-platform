import type Database from "better-sqlite3";
import { AutoWaitlistError, type AutoWaitlistSnapshot } from "./waitlist.js";
import type { AutoItem } from "./coordination.js";
import { digest, strictJson, object, integer, oneOf, text, SHA256 } from "../workflows/contracts.js";
export interface AutoNotice {
  sequence: number; fingerprint: string; ticket: string | null;
  state: "waitlist-changed" | "awaiting-review" | "blocked" | "uncertain" | "review-ready";
  delivery: "unknown" | "requested" | "unavailable";
  reason: "none" | "desktop-unavailable" | "notifier-unavailable" | "request-failed";
  at: string;
}
function parseNotice(raw: string): AutoNotice {
  try {
    const r = object(strictJson(Buffer.from(raw)), ["sequence", "fingerprint", "ticket", "state", "delivery", "reason", "at"]);
    return { sequence: integer(r.sequence, 1), fingerprint: text(r.fingerprint, SHA256), ticket: r.ticket === null ? null : text(r.ticket, /^(?:PAP|PAPC)-\d+$/),
      state: oneOf(r.state, ["waitlist-changed", "awaiting-review", "blocked", "uncertain", "review-ready"]), delivery: oneOf(r.delivery, ["unknown", "requested", "unavailable"]),
      reason: oneOf(r.reason, ["none", "desktop-unavailable", "notifier-unavailable", "request-failed"]), at: text(r.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) };
  } catch { throw new AutoWaitlistError("AUTO_STORE"); }
}
/** Unsigned informational delivery owner. Claim precedes external send: a lost
 * reply is unknown, never a reason to repeat a notification or any launch. */
export class RegistryAutoNotifications {
  constructor(readonly db: Database.Database) {}
  last(): AutoNotice | null {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auto_notices'").get()) return null;
    const row = this.db.prepare("SELECT body FROM auto_notices ORDER BY sequence DESC LIMIT 1").get() as { body: string } | undefined;
    return row ? parseNotice(row.body) : null;
  }
  claim(snapshot: AutoWaitlistSnapshot | null, item: AutoItem | null, fresh: boolean): AutoNotice | null {
    const state = item && ["awaiting-review", "blocked", "uncertain", "review-ready"].includes(item.state) ? item.state as AutoNotice["state"] : !fresh ? "blocked" : "waitlist-changed";
    const candidates = snapshot?.entries.filter(e => e.route !== "observe").map(e => [e.id, e.route, e.priority, e.reasons]) ?? [];
    const fingerprint = digest(JSON.stringify({ candidates, fresh, item: item ? [item.itemId, item.state, item.reason, item.subjectSha256, item.decisionId, item.draft?.operationId, item.dispatch?.operationId] : null }));
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT sequence,fingerprint FROM auto_notice_state WHERE singleton=1").get() as { sequence: number; fingerprint: string } | undefined;
      if (previous?.fingerprint === fingerprint) return null;
      const sequence = (previous?.sequence ?? 0) + 1;
      this.db.prepare("INSERT INTO auto_notice_state(singleton,sequence,fingerprint) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET sequence=excluded.sequence,fingerprint=excluded.fingerprint").run(sequence, fingerprint);
      if (fresh && !candidates.length && (!item || !["awaiting-review", "blocked", "uncertain", "review-ready"].includes(item.state))) return null;
      const notice: AutoNotice = { sequence, fingerprint, ticket: item?.ticket ?? null, state, delivery: "unknown", reason: "none", at: new Date().toISOString() };
      this.db.prepare("INSERT INTO auto_notices(sequence,body) VALUES(?,?)").run(sequence, JSON.stringify(notice)); return notice;
    }).immediate();
  }
  result(notice: AutoNotice, delivery: Exclude<AutoNotice["delivery"], "unknown">, reason: AutoNotice["reason"]): AutoNotice {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT body FROM auto_notices WHERE sequence=?").get(notice.sequence) as { body: string } | undefined;
      if (!row || JSON.stringify(parseNotice(row.body)) !== JSON.stringify(notice)) throw new AutoWaitlistError("AUTO_BUSY");
      const result = parseNotice(JSON.stringify({ ...notice, delivery, reason }));
      this.db.prepare("UPDATE auto_notices SET body=? WHERE sequence=?").run(JSON.stringify(result), notice.sequence); return result;
    }).immediate();
  }
  /** Monotonic observation interval, no catch-up queue and no stale PID unlock. */
  takeWake(now = Date.now(), admit: () => boolean = () => true): boolean {
    if (!Number.isSafeInteger(now) || now < 0) throw new AutoWaitlistError("AUTO_INPUT");
    return this.db.transaction(() => {
      if (!admit()) return false;
      const row = this.db.prepare("SELECT at_ms FROM auto_wake WHERE singleton=1").get() as { at_ms: number } | undefined;
      if (row && now - row.at_ms < 30 * 60_000) return false;
      this.db.prepare("INSERT INTO auto_wake(singleton,at_ms) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET at_ms=excluded.at_ms").run(now); return true;
    }).immediate();
  }
}
export function autoNotificationText(notice: AutoNotice): string {
  const states: Record<AutoNotice["state"], string> = { "waitlist-changed": "PAP/PAPC waitlist changed", "awaiting-review": "full package needs review", blocked: "work is blocked", uncertain: "original work outcome is uncertain", "review-ready": "local work is ready for review; human UAT is pending" };
  try {
    const ticket = typeof notice.ticket === "string" && notice.ticket.length <= 64 && /^(?:PAP|PAPC)-\d+$/.test(notice.ticket) ? notice.ticket : "PPA auto";
    const state = typeof notice.state === "string" && Object.hasOwn(states, notice.state) ? states[notice.state] : "work needs inspection";
    return `${ticket}: ${state}. Run ppa auto.`;
  } catch { return "PPA auto: work needs inspection. Run ppa auto."; }
}
