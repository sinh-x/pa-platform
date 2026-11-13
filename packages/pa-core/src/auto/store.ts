import { closeSync, constants, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { openArtifactDirectory, readArtifactFile } from "../artifacts/manifest.js";
import { AdvisoryFiles } from "../operations/files.js";
import { getAiUsageDir } from "../paths.js";
import { loadReposYaml } from "../repos.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { isCanonicalTicketId } from "../tickets/validate.js";
import { AUTO_PROJECTS, AUTO_REASON_TEXT, AUTO_WAITLIST_VERSION, AutoWaitlistError, autoPlainText, type AutoWaitlistSnapshot } from "./waitlist.js";

const STATE_FILE = "waitlist.json", LOCK_FILE = ".scan.lock";
const MAX_STATE_BYTES = 32 * 1024 * 1024;
export interface AutoWaitlistState {
  schemaVersion: "pa-auto-state/v1";
  snapshot: AutoWaitlistSnapshot | null;
  lastAttempt: { at: string; outcome: "completed" | "failed"; code: "AUTO_SOURCE" | "AUTO_LIMIT" | null };
}
export interface AutoWaitlistView {
  state: AutoWaitlistState | null;
  freshness: "missing" | "fresh" | "stale";
  scan: "idle" | "busy-or-unsettled";
}
function validDate(v: unknown): v is string { return typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)); }
function strings(v: unknown, pattern?: RegExp): v is string[] { return Array.isArray(v) && v.every(s => typeof s === "string" && (!pattern || pattern.test(s))); }
function parseState(bytes: Buffer): AutoWaitlistState {
  const state = parseReviewEvidenceJson(bytes, "auto.state") as AutoWaitlistState;
  if (!state || state.schemaVersion !== "pa-auto-state/v1" || !state.lastAttempt || !validDate(state.lastAttempt.at)
    || !["completed", "failed"].includes(state.lastAttempt.outcome)
    || ![null, "AUTO_SOURCE", "AUTO_LIMIT"].includes(state.lastAttempt.code)) throw new AutoWaitlistError("AUTO_STORE");
  const s = state.snapshot;
  if (s !== null) {
    if (!s || s.schemaVersion !== AUTO_WAITLIST_VERSION || typeof s.version !== "string" || !/^[0-9a-f-]{36}$/.test(s.version)
      || !validDate(s.observedAt) || !validDate(s.completedAt) || s.executionAdmitted !== false
      || !Array.isArray(s.projects) || s.projects.length !== 2 || !Array.isArray(s.entries) || s.entries.length > 20_000) throw new AutoWaitlistError("AUTO_STORE");
    if (new Set(s.projects.map(p => p.key)).size !== 2 || s.projects.some(p => !Object.hasOwn(AUTO_PROJECTS, p.key)
      || p.prefix !== AUTO_PROJECTS[p.key] || typeof p.canonicalRoot !== "string" || !isAbsolute(p.canonicalRoot))) throw new AutoWaitlistError("AUTO_STORE");
    for (const e of s.entries) {
      if (!e || !Object.hasOwn(AUTO_PROJECTS, e.project) || !isCanonicalTicketId(e.id) || !new RegExp(`^${AUTO_PROJECTS[e.project]}-\\d+$`).test(e.id)
        || typeof e.title !== "string" || e.title !== autoPlainText(e.title) || !["critical", "high", "medium", "low"].includes(e.priority)
        || !["idea", "requirement-review", "pending-approval", "pending-implementation", "implementing", "review-uat", "done", "rejected", "cancelled"].includes(e.status)
        || !validDate(e.createdAt) || !/^[a-f0-9]{64}$/.test(e.ticketSha256) || typeof e.archived !== "boolean" || typeof e.originalWorkflow !== "boolean"
        || !strings(e.unresolvedDependencies) || e.unresolvedDependencies.some(id => !isCanonicalTicketId(id)) || !strings(e.blockingBulletins, /^B-\d+$/) || !strings(e.competingDeployments, /^d-[0-9a-f]{6}$/)
        || !["draft", "review-package", "review-start", "observe"].includes(e.route) || !Array.isArray(e.reasons) || !e.reasons.length || e.reasons.some(r => !Object.hasOwn(AUTO_REASON_TEXT, r))
        || !e.documents || !["missing", "unverified", "pending", "approved", "blocked"].includes(e.documents.state)) throw new AutoWaitlistError("AUTO_STORE");
      const d = e.documents;
      if (d.subjectSha256 !== undefined && !/^[a-f0-9]{64}$/.test(d.subjectSha256)
        || d.packageId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(d.packageId)
        || d.decisionId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(d.decisionId)
        || d.revision !== undefined && (!Number.isSafeInteger(d.revision) || d.revision < 1)) throw new AutoWaitlistError("AUTO_STORE");
    }
    if (new Set(s.entries.map(e => e.id)).size !== s.entries.length
      || s.recommendation !== null && !s.entries.some(e => e.id === s.recommendation && e.route !== "observe")) throw new AutoWaitlistError("AUTO_STORE");
  }
  if (state.lastAttempt.outcome === "completed" && (!s || state.lastAttempt.code !== null)) throw new AutoWaitlistError("AUTO_STORE");
  return state;
}
export function parseAutoWaitlistSnapshot(bytes: Buffer): AutoWaitlistSnapshot {
  const snapshot = parseReviewEvidenceJson(bytes, "auto.snapshot") as AutoWaitlistSnapshot;
  const state = parseState(Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-state/v1", snapshot,
    lastAttempt: { at: snapshot?.completedAt, outcome: "completed", code: null } })));
  return state.snapshot!;
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path); return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}
/** Unsigned coordination data only. This is never a decision/registry import. */
export class AutoWaitlistStore {
  constructor(readonly root = getAiUsageDir()) {}
  private directory(): string { return resolve(this.root, "auto"); }
  private assertExternal(): void {
    if (!isAbsolute(this.root) || resolve(this.root) !== this.root) throw new AutoWaitlistError("AUTO_STORE");
    for (const repo of Object.values(loadReposYaml())) if (contained(repo.path, this.directory())) throw new AutoWaitlistError("AUTO_STORE");
  }
  /** No mkdir, lock, initialization, migration or repair on a reader. */
  read(now = Date.now()): AutoWaitlistView {
    try {
      const directory = this.directory();
      try { lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: null, freshness: "missing", scan: "idle" }; throw error; }
      const fd = openArtifactDirectory(directory, "ARTIFACT_STALE"); closeSync(fd);
      let state: AutoWaitlistState | null = null;
      try { lstatSync(resolve(directory, STATE_FILE)); state = parseState(readArtifactFile(resolve(directory, STATE_FILE), MAX_STATE_BYTES, "ARTIFACT_STALE")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let busy = false;
      try { lstatSync(resolve(directory, LOCK_FILE)); busy = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const completed = state?.snapshot?.completedAt;
      const fresh = state?.lastAttempt.outcome === "completed" && completed && now >= Date.parse(completed) && now - Date.parse(completed) < 30 * 60_000;
      return { state, freshness: !state?.snapshot ? "missing" : fresh && !busy ? "fresh" : "stale", scan: busy ? "busy-or-unsettled" : "idle" };
    } catch { throw new AutoWaitlistError("AUTO_STORE"); }
  }
  /** Exclusive cross-process scanner boundary. Overlap coalesces to retained
   * state. A crash leaves a visible unsettled lock; never guess death from PID.
   * Atomic rename+fsync is owned by AdvisoryFiles, outside product repositories. */
  scan(produce: () => AutoWaitlistSnapshot): AutoWaitlistView {
    this.assertExternal();
    const files = new AdvisoryFiles(this.root);
    files.file("auto", undefined, true);
    const directory = openArtifactDirectory(this.directory(), "ARTIFACT_STALE");
    const lock = `/proc/self/fd/${directory}/${LOCK_FILE}`;
    let acquired = false;
    try {
      let fd: number;
      try { fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); acquired = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.read(); throw error; }
      try { writeFileSync(fd, "pa-auto-scan/v1\n"); fsyncSync(fd); } finally { closeSync(fd); }
      fsyncSync(directory);
      const previous = this.read().state;
      let next: AutoWaitlistState;
      try {
        const snapshot = produce();
        next = { schemaVersion: "pa-auto-state/v1", snapshot, lastAttempt: { at: snapshot.completedAt, outcome: "completed", code: null } };
      } catch (error) {
        next = { schemaVersion: "pa-auto-state/v1", snapshot: previous?.snapshot ?? null,
          lastAttempt: { at: new Date().toISOString(), outcome: "failed", code: error instanceof AutoWaitlistError && error.code === "AUTO_LIMIT" ? "AUTO_LIMIT" : "AUTO_SOURCE" } };
      }
      const bytes = Buffer.from(JSON.stringify(next));
      if (bytes.length > MAX_STATE_BYTES) throw new AutoWaitlistError("AUTO_LIMIT");
      parseState(bytes);
      files.file(`auto/${STATE_FILE}`, bytes.toString("utf8"));
    } catch (error) { throw error instanceof AutoWaitlistError ? error : new AutoWaitlistError("AUTO_STORE"); }
    finally {
      try { if (acquired) { unlinkSync(lock); fsyncSync(directory); } } finally { closeSync(directory); }
    }
    return this.read();
  }
}
