import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoWaitlistError, AUTO_PROJECTS, buildAutoWaitlist, routeAutoTicket, type AutoTicketObservation } from "../auto/waitlist.js";
import { scanAutoWaitlist } from "../auto/source.js";
import { AutoWaitlistStore } from "../auto/store.js";
import { autoWaitlistDiagnostic, autoWaitlistPage, formatAutoWaitlist } from "../auto/presentation.js";
import { closeDb, getDb } from "../registry/db.js";
import { RegistryDocumentJournal } from "../registry/documents.js";
import { documentDestination, type DocumentPackage } from "../documents/package-contract.js";
import { digest } from "../workflows/contracts.js";

let root: string, usage: string, config: string, saved: NodeJS.ProcessEnv;
const at = "2026-11-13T10:00:00.000Z";
function observation(overrides: Partial<AutoTicketObservation> = {}): AutoTicketObservation {
  return { id: "PAP-001", project: "pa-platform", title: "Synthetic ticket", priority: "medium", status: "idea", createdAt: at,
    ticketSha256: "a".repeat(64), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [],
    originalWorkflow: false, documents: { state: "missing" }, ...overrides };
}
function snapshot(tickets = [observation()]) {
  const now = new Date().toISOString();
  return buildAutoWaitlist({ observedAt: now, completedAt: now, projects: Object.entries(AUTO_PROJECTS).map(([key, prefix]) => ({ key: key as keyof typeof AUTO_PROJECTS, prefix, canonicalRoot: join(root, key) })), tickets });
}
function ticket(id: string, overrides: Record<string, unknown> = {}) {
  const row = { id, project: id.startsWith("PAPC-") ? "pa-platform-config" : "pa-platform", title: "Synthetic ticket", priority: "medium", status: "idea",
    createdAt: at, tags: [], blockedBy: [], doc_refs: [], summary: "", description: "Synthetic source body", ...overrides };
  writeFileSync(join(usage, "tickets", `${id}.json`), JSON.stringify(row)); return row;
}
function tree(path: string, prefix = ""): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? Object.entries(tree(join(path, e.name), `${prefix}${e.name}/`)) : [[`${prefix}${e.name}`, digest(readFileSync(join(path, e.name)))]]));
}
beforeEach(() => {
  saved = { ...process.env }; root = mkdtempSync(join(tmpdir(), "pap302-auto-")); usage = join(root, "usage"); config = join(root, "config");
  for (const p of ["tickets", "bulletins/active"]) mkdirSync(join(usage, p), { recursive: true });
  for (const p of [config, join(root, "pa-platform"), join(root, "pa-platform-config")]) mkdirSync(p);
  process.env.PA_AI_USAGE_HOME = usage; process.env.PA_PLATFORM_CONFIG = config; process.env.PA_PLATFORM_HOME = join(root, "pa-platform-config");
  process.env.PA_REGISTRY_DB = join(usage, "registry.db");
  writeFileSync(join(config, "config.yaml"), JSON.stringify({ repos: Object.fromEntries(Object.entries(AUTO_PROJECTS).map(([key, prefix]) => [key, { path: join(root, key), prefix }])) }));
  getDb(); closeDb();
});
afterEach(() => { closeDb(); process.env = saved; rmSync(root, { recursive: true, force: true }); });

test("routes all stages without status-only approval or duplicate drafts", () => {
  assert.equal(routeAutoTicket(observation()).route, "draft");
  assert.equal(routeAutoTicket(observation({ documents: { state: "pending" } })).route, "review-package");
  assert.equal(routeAutoTicket(observation({ documents: { state: "approved" } })).route, "review-start");
  assert.equal(routeAutoTicket(observation({ status: "pending-implementation", documents: { state: "unverified" } })).route, "observe");
  for (const status of ["done", "rejected", "cancelled", "implementing", "review-uat"] as const) assert.equal(routeAutoTicket(observation({ status })).route, "observe");
  for (const overrides of [{ archived: true }, { unresolvedDependencies: ["PAP-002"] }, { blockingBulletins: ["B-001"] }, { competingDeployments: ["d-aaaaaa"] }, { originalWorkflow: true }, { documents: { state: "blocked" as const, reason: "pending-effect" as const } }]) {
    assert.equal(routeAutoTicket(observation(overrides)).route, "observe");
  }
});
test("all candidates remain reachable on 100-row pages; deterministic recommendation is not execution", () => {
  const tickets = Array.from({ length: 205 }, (_, i) => observation({ id: `PAP-${String(i + 1).padStart(3, "0")}` }));
  tickets.push(observation({ id: "PAPC-001", project: "pa-platform-config", priority: "critical", archived: true }));
  const s = snapshot(tickets), view = { state: { schemaVersion: "pa-auto-state/v1" as const, snapshot: s, lastAttempt: { at, outcome: "completed" as const, code: null } }, freshness: "fresh" as const, scan: "idle" as const };
  assert.equal(s.recommendation, "PAP-001"); assert.equal(s.executionAdmitted, false);
  const ids = [1, 2, 3].flatMap(page => autoWaitlistPage(view, page).entries.map(e => e.id));
  assert.equal(new Set(ids).size, 205); assert.equal(autoWaitlistPage(view, 1, "excluded").total, 1);
  assert.throws(() => autoWaitlistPage(view, 4), AutoWaitlistError);
  assert.match(formatAutoWaitlist(view), /not an execution order/);
});
test("pure readers do not initialize missing directories, registry or state", () => {
  const absent = join(root, "absent");
  assert.deepEqual(new AutoWaitlistStore(absent).read(), { state: null, freshness: "missing", scan: "idle" });
  assert.equal(existsSync(absent), false);
});
test("complete two-project scan has zero source byte changes and exposes dependencies/advanced/excluded work", () => {
  ticket("PAP-001"); ticket("PAPC-001"); ticket("PAP-002", { status: "done" });
  ticket("PAP-003", { blockedBy: ["PAP-002"] }); ticket("PAP-004", { blockedBy: ["PAP-999"] });
  ticket("PAP-005", { status: "implementing" }); ticket("PAP-006", { tags: ["archived"] });
  ticket("PAP-007", { status: "pending-implementation", doc_refs: [{ type: "requirements", path: "anything.md", primary: true }] });
  const before = tree(root), s = scanAutoWaitlist();
  assert.deepEqual(tree(root), before); assert.equal(s.entries.length, 8);
  assert.equal(s.entries.find(e => e.id === "PAP-003")?.route, "draft");
  assert.deepEqual(s.entries.find(e => e.id === "PAP-004")?.unresolvedDependencies, ["PAP-999"]);
  assert.equal(s.entries.find(e => e.id === "PAP-007")?.route, "observe");
});
test("canonical unpadded IDs are included and aliases never duplicate or hide missing targets", () => {
  ticket("PAP-1"); ticket("PAPC-2");
  writeFileSync(join(usage, "tickets/PAP-003.json"), JSON.stringify({ _alias: true, movedTo: "PAP-1" }));
  const s = scanAutoWaitlist(); assert.deepEqual(s.entries.map(e => e.id), ["PAP-1", "PAPC-2"]);
  new AutoWaitlistStore().scan(() => s);
  writeFileSync(join(usage, "tickets/PAP-003.json"), JSON.stringify({ _alias: true, movedTo: "PAP-999" }));
  assert.throws(scanAutoWaitlist, AutoWaitlistError);
  writeFileSync(join(usage, "tickets/PAP-003.json"), JSON.stringify({ _alias: true, movedTo: "PAP-003" }));
  assert.throws(scanAutoWaitlist, AutoWaitlistError);
});
test("active bulletins really block and malformed bulletins fail closed", () => {
  ticket("PAP-001"); const file = join(usage, "bulletins/active/notice.md");
  writeFileSync(file, "---\nid: B-001\ntitle: Synthetic notice\nstatus: active\nblock: all\nexcept: [requirements]\ncreated: 2026-11-13\n---\nfixture\n");
  assert.deepEqual(scanAutoWaitlist().entries[0]!.blockingBulletins, ["B-001"]);
  writeFileSync(file, "not a valid bulletin"); assert.throws(scanAutoWaitlist, AutoWaitlistError);
});
test("live, unknown and partial owners are retained; successful terminal deployments are not guessed live", () => {
  ticket("PAP-001"); ticket("PAPC-001"); const db = getDb();
  db.prepare("INSERT INTO deployments (deployment_id,team,status,ticket_id,completed_at) VALUES (?,?,?,?,?)").run("d-aaaaaa", "builder", "partial", "PAP-001", at);
  db.prepare("INSERT INTO deployments (deployment_id,team,status,ticket_id,completed_at) VALUES (?,?,?,?,?)").run("d-bbbbbb", "builder", "success", "PAPC-001", at);
  closeDb(); const s = scanAutoWaitlist();
  assert.equal(s.entries.find(e => e.id === "PAP-001")?.route, "observe");
  assert.equal(s.entries.find(e => e.id === "PAPC-001")?.route, "draft");
});
test("unsafe sources, missing registered project and missing registry never publish fresh empty lists", () => {
  ticket("PAP-001"); const path = join(usage, "tickets/PAP-002.json"); symlinkSync(join(usage, "tickets/PAP-001.json"), path);
  assert.throws(scanAutoWaitlist, AutoWaitlistError); rmSync(path);
  rmSync(join(root, "pa-platform-config"), { recursive: true }); assert.throws(scanAutoWaitlist, AutoWaitlistError);
  mkdirSync(join(root, "pa-platform-config")); rmSync(process.env.PA_REGISTRY_DB!); assert.throws(scanAutoWaitlist, AutoWaitlistError);
  assert.equal(existsSync(process.env.PA_REGISTRY_DB!), false);
});
test("hostile titles are bounded plain text and secret-like configured content is withheld", () => {
  writeFileSync(join(config, "sensitive-patterns.yaml"), "contents:\n  - 'SYNTHETIC_PRIVATE'\n");
  ticket("PAP-001", { title: "bad\u001b[31m\nCondition: misleading\u202e" + "x".repeat(500) });
  ticket("PAP-002", { title: "SYNTHETIC_PRIVATE fixture" });
  const entries = scanAutoWaitlist().entries;
  assert.ok(entries[0]!.title.length <= 160); assert.doesNotMatch(entries[0]!.title, /[\u001b\n\u202e]/);
  assert.equal(entries[1]!.title, "[title withheld]");
});
function packageFixture(id: string, publication: boolean) {
  const db = getDb(), journal = new RegistryDocumentJournal(db), bytes = [Buffer.from("Synthetic brief"), Buffer.from("# Synthetic requirements"), Buffer.from("# Synthetic UAT; not run")];
  const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "synthetic-auto", revision: 1,
    repository: { key: "pa-platform", root: join(root, "pa-platform") }, ticket: id, predecessor: null,
    members: (["brief", "requirements", "uat"] as const).map((role, i) => ({ id: role, role, mediaType: "text/markdown", source: `agent-teams/requirements/artifacts/drafts/d-aaaaaa/${role}.md`, description: "Synthetic only", bytes: bytes[i]!.length, sha256: digest(bytes[i]!) })),
    references: [], effects: { publish: true, queue: false, route: { team: "builder", mode: "orchestrator" } } };
  const sha = journal.freeze(subject, 0, bytes);
  if (publication) {
    const evidence = Buffer.from("Synthetic decision fixture, NOT a real approval");
    journal.append("pa-platform", id, 1, { kind: "decision", subjectSha256: sha, decisionId: "decision-fixture", outcome: "approved", principal: "fixture", evidenceSha256: digest(evidence), callerIdentity: "a".repeat(64) }, [evidence]);
    journal.append("pa-platform", id, 2, { kind: "intent", subjectSha256: sha, operationId: "effect-fixture", decisionId: "decision-fixture", operation: "publish" });
    journal.append("pa-platform", id, 3, { kind: "result", subjectSha256: sha, operationId: "effect-fixture", outcome: "completed", code: "DOCUMENT_PUBLISHED" });
    const refs = subject.members.map((member, i) => {
      const destination = documentDestination(subject, member), path = join(usage, destination); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes[i]!);
      return { type: member.role, path: destination, primary: member.role === "requirements" };
    });
    ticket(id, { doc_refs: refs });
  }
  closeDb(); return { subject, sha };
}
test("pending and published packages are reused with exact hashes, never inferred from status", () => {
  ticket("PAP-001"); ticket("PAP-002"); packageFixture("PAP-001", false); const { subject, sha } = packageFixture("PAP-002", true);
  let s = scanAutoWaitlist(); assert.equal(s.entries[0]!.route, "review-package"); assert.equal(s.entries[1]!.route, "review-start"); assert.equal(s.entries[1]!.documents.subjectSha256, sha);
  writeFileSync(join(usage, documentDestination(subject, subject.members[1]!)), "changed bytes");
  s = scanAutoWaitlist(); assert.equal(s.entries[1]!.route, "observe"); assert.deepEqual(s.entries[1]!.reasons, ["document-conflict"]);
});
test("revoked approvals and partial publication never appear as ready work", () => {
  ticket("PAP-001"); const { sha } = packageFixture("PAP-001", true);
  const journal = new RegistryDocumentJournal(getDb()), evidence = Buffer.from("Synthetic revoked fixture");
  journal.append("pa-platform", "PAP-001", 4, { kind: "revoked", subjectSha256: sha, decisionId: "decision-fixture", evidenceSha256: digest(evidence) }, [evidence]); closeDb();
  assert.equal(scanAutoWaitlist().entries[0]!.route, "observe");
  ticket("PAP-002"); const pending = packageFixture("PAP-002", false), other = new RegistryDocumentJournal(getDb());
  other.append("pa-platform", "PAP-002", 1, { kind: "decision", subjectSha256: pending.sha, decisionId: "decision-partial", outcome: "approved", principal: "fixture", evidenceSha256: digest(evidence), callerIdentity: "a".repeat(64) }, [evidence]); closeDb();
  ticket("PAP-002", { doc_refs: [{ type: "requirements", primary: true, path: documentDestination(pending.subject, pending.subject.members[1]!) }] });
  assert.deepEqual(scanAutoWaitlist().entries.find(e => e.id === "PAP-002")?.reasons, ["document-conflict"]);
});
test("unsettled document effects block, even with a completed publication", () => {
  ticket("PAP-001"); const { sha } = packageFixture("PAP-001", true), journal = new RegistryDocumentJournal(getDb());
  journal.append("pa-platform", "PAP-001", 4, { kind: "intent", subjectSha256: sha, decisionId: "decision-fixture", operationId: "queue-fixture", operation: "queue" }); closeDb();
  assert.deepEqual(scanAutoWaitlist().entries[0]!.reasons, ["pending-effect"]);
});
test("failed scan retains the same complete version and becomes visibly stale", () => {
  const store = new AutoWaitlistStore(), initial = store.scan(() => snapshot());
  assert.equal(initial.freshness, "fresh");
  const failed = store.scan(() => { throw new Error("private exception must not persist"); });
  assert.equal(failed.freshness, "stale"); assert.equal(failed.state?.snapshot?.version, initial.state?.snapshot?.version);
  assert.doesNotMatch(readFileSync(join(usage, "auto/waitlist.json"), "utf8"), /private exception/);
  assert.match(formatAutoWaitlist(failed), /latest scan failed/);
  assert.equal(store.read(Date.now() + 31 * 60_000).freshness, "stale");
});
test("reader rejects malformed snapshots, aliases and hostile stored context without repair", () => {
  const store = new AutoWaitlistStore(); store.scan(() => snapshot()); const file = join(usage, "auto/waitlist.json");
  const before = readFileSync(file); const bad = JSON.parse(before.toString()); bad.snapshot.entries[0].title = "unsafe\nnew line"; writeFileSync(file, JSON.stringify(bad));
  assert.throws(() => store.read(), AutoWaitlistError); rmSync(file); symlinkSync(join(root, "config/config.yaml"), file);
  assert.throws(() => store.read(), AutoWaitlistError);
});
test("scan storage is refused inside a registered product repository", () => {
  assert.throws(() => new AutoWaitlistStore(join(root, "pa-platform")).scan(() => snapshot()), AutoWaitlistError);
  assert.equal(existsSync(join(root, "pa-platform/auto")), false);
});
const worker = fileURLToPath(new URL("./fixtures/auto-scan-worker.mts", import.meta.url));
function launchWorker() { return spawn(process.execPath, ["--import=tsx", worker, usage, root], { env: process.env, stdio: ["ignore", "pipe", "pipe"] }); }
async function waitFor(path: string) { for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(existsSync(path)); }
test("real process overlap admits one scanner and coalesces the other", async () => {
  const first = launchWorker(); let out = ""; first.stdout.on("data", b => out += b); const firstExit = once(first, "exit");
  try {
    await waitFor(join(root, "producer-started")); const second = launchWorker(); let secondOut = ""; second.stdout.on("data", b => secondOut += b);
    const [secondCode] = await once(second, "exit"); const [firstCode] = await firstExit;
    assert.equal(firstCode, 0); assert.equal(secondCode, 0); assert.match(secondOut, /busy-or-unsettled/); assert.match(out, /idle/);
    assert.equal(readFileSync(join(root, "producer-started"), "utf8"), "started\n");
  } finally { if (first.exitCode === null) first.kill("SIGKILL"); }
});
test("crashed scanner retains unsettled identity and never silently starts a replacement", async () => {
  const child = launchWorker(), exit = once(child, "exit");
  try { await waitFor(join(root, "producer-started")); child.kill("SIGKILL"); await exit; }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  let called = false; const view = new AutoWaitlistStore().scan(() => { called = true; return snapshot(); });
  assert.equal(called, false); assert.equal(view.scan, "busy-or-unsettled");
});
test("known blocker messages have one bounded five-label envelope and no raw causes", () => {
  const hostile = new Proxy({}, { get() { throw new Error("must not inspect"); } });
  assert.equal(autoWaitlistDiagnostic(hostile as never), autoWaitlistDiagnostic("AUTO_STORE"));
  assert.equal(autoWaitlistDiagnostic("x".repeat(2001) as never), autoWaitlistDiagnostic("AUTO_STORE"));
  for (const code of ["AUTO_INPUT", "AUTO_SOURCE", "AUTO_LIMIT", "AUTO_STORE", "AUTO_BUSY", "AUTO_UNAVAILABLE"] as const) {
    const text = autoWaitlistDiagnostic(code); assert.ok(text.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.equal(text.split(`${label}:`).length - 1, 1);
    for (const label of ["Impact:", "Actor:", "New approval:", "Prerequisite:"]) assert.ok(text.includes(label));
  }
});
