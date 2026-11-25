import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_SCRIPT } from "../session-dashboard-page.js";
import type { SessionSnapshot } from "../session-capture.js";
import type { SessionObjectivePreview } from "@pa-platform/pa-core";

/** Minimal DOM contract fixture, not a browser/keyboard/layout observation. */
class Element {
  children: Element[] = []; ownText = ""; value = ""; checked = false; disabled = false; hidden = false; open = false; className = "";
  attributes = new Map<string, string>(); listeners = new Map<string, (event?: { preventDefault(): void }) => unknown>();
  constructor(readonly tag: string) {}
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(" "); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value: string) { throw new Error("Unsafe HTML insertion"); }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.ownText = ""; this.children = items; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(event: string, fn: (event?: { preventDefault(): void }) => unknown) { this.listeners.set(event, fn); }
  fire(event: string) { return this.listeners.get(event)?.({ preventDefault() {} }); }
  descendants(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.descendants(tag)]); }
  withClass(name: string): Element[] { return this.children.flatMap(child => [...(child.className.split(" ").includes(name) ? [child] : []), ...child.withClass(name)]); }
}
function snapshot(count = 1): SessionSnapshot {
  return { schemaVersion: "ppa-sessions/v1", scope: "local-linux-ppa-pi-existing-launch-evidence", capture: { startedAt: new Date(0).toISOString(), endedAt: new Date(1000).toISOString() }, filters: { all: false },
    coverage: { complete: true, reasons: [], candidatesObserved: count, diagnosticsOmitted: 0 }, rows: Array.from({ length: count }, (_, i) => ({ deploymentId: `d-${i.toString(16).padStart(6, "0")}`, ticket: "PAP-286", team: "rogue-one", mode: "rogue-one", repository: "project", startedAt: null, registryStatus: "success", candidatePid: 42, process: { state: "verified-open", pid: 42 }, herdr: { state: "unmatched", reason: "no-foreground-ancestry-match" } })) };
}
const location = { session: "s1", workspaceId: "w1", workspaceLabel: "Project", tabId: "t1", tabLabel: "Dashboard", paneId: "p1", terminalId: "term1" };
function dashboardCapture(inventory: SessionSnapshot, byDeployment: Record<string, SessionObjectivePreview> = {}) {
  return { schemaVersion: "ppa-session-dashboard/v1", inventory, objectives: { capture: { startedAt: new Date(1000).toISOString(), endedAt: new Date(1000).toISOString() }, byDeployment } };
}
function client() {
  const elements = new Map([...DASHBOARD_HTML.matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element(match[1]!)]));
  elements.get("location")!.value = "all";
  const requests: Array<{ url: string; options: Record<string, unknown>; resolve: (reply: { ok: boolean; status?: number; json(): Promise<unknown> }) => void; reject: (error: Error) => void }> = [];
  const intervals: Array<() => void> = [], timeouts = new Map<number, () => void>(); let nextTimer = 0, now = 1000;
  runInNewContext(DASHBOARD_SCRIPT, {
    document: { getElementById: (id: string) => elements.get(id), createElement: (tag: string) => new Element(tag) },
    URLSearchParams, AbortController, Date: class extends Date { static now() { return now; } },
    setInterval: (fn: () => void) => { intervals.push(fn); },
    setTimeout: (fn: () => void) => { const id = ++nextTimer; timeouts.set(id, fn); return id; }, clearTimeout: (id: number) => timeouts.delete(id),
    fetch: (url: string, options: Record<string, unknown>) => new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject }); (options.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted"))); }),
  });
  const el = (id: string) => elements.get(id)!;
  async function settle(data: unknown, index = requests.length - 1) { const payload = (data as SessionSnapshot)?.schemaVersion === "ppa-sessions/v1" ? dashboardCapture(data as SessionSnapshot) : data; requests[index]!.resolve({ ok: true, json: async () => payload }); await flush(); }
  async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
  return { el, requests, settle, flush, intervals, timeouts, setNow: (time: number) => { now = time; intervals.forEach(fn => fn()); } };
}
test("compact semantic page has disclosure controls, external bundled assets only and no old table/group selector", () => {
  assert.equal((DASHBOARD_HTML.match(/<h1>/g) ?? []).length, 1);
  for (const id of ["deployment", "ticket", "repo", "all", "search", "location", "refresh", "apply", "status", "capture", "coverage", "applied", "results", "previous", "next", "pagination"]) assert.ok(DASHBOARD_HTML.includes(`id="${id}"`));
  assert.match(DASHBOARD_HTML, /aria-live="polite"/); assert.match(DASHBOARD_HTML, /No automatic refresh/);
  assert.match(DASHBOARD_HTML, /id="refresh" type="submit" form="filters"/);
  assert.ok(!/id="group"|<table|https?:|\son\w+=|<script(?! src=)/.test(DASHBOARD_HTML));
  assert.ok(!/innerHTML|localStorage|sessionStorage|WebSocket|EventSource|window\.open/.test(DASHBOARD_SCRIPT));
  for (const pattern of [/:focus-visible/, /@media print/, /\[hidden\]/, /grid-template-columns:repeat\(auto-fit/]) assert.match(DASHBOARD_CSS, pattern);
});
test("initial loading, one flight, exact server filters, capture metadata and empty results retain their contracts", async () => {
  const view = client(); assert.equal(view.requests.length, 1); assert.match(view.el("status").textContent, /Loading initial/);
  for (const control of ["refresh", "apply", "ticket", "repo", "all"]) assert.equal(view.el(control).disabled, true);
  await view.el("filters").fire("submit"); assert.equal(view.requests.length, 1);
  await view.settle(snapshot(0)); assert.match(view.el("results").textContent, /No matching sessions in this capture/);
  assert.equal(view.el("refresh").disabled, false); assert.equal(view.el("pagination").hidden, true);
  view.el("ticket").value = "PAP-286"; view.el("repo").value = "project"; view.el("all").checked = true;
  const pending = view.el("filters").fire("submit"); assert.equal(view.requests[1]!.url, "/v1/dashboard?ticket=PAP-286&repo=project&all=true");
  assert.equal(view.requests[1]!.options.credentials, "omit"); assert.equal(view.requests[1]!.options.redirect, "error"); assert.match(view.el("status").textContent, /previous capture/);
  const data = snapshot(); data.filters = { all: true, ticket: "PAP-286", repo: "project" }; await view.settle(data); await pending;
  assert.match(view.el("applied").textContent, /"all":true/); assert.match(view.el("capture").textContent, /1970/); assert.match(view.el("count").textContent, /1 candidates · 1 verified open/);
});
test("exact repository/ticket grouping merges deployments only within their association; full facts stay in closed details", async () => {
  const view = client(), data = snapshot(8);
  data.rows[2]!.ticket = "PAP-281";
  for (const i of [3, 4]) data.rows[i]!.repository = "other";
  data.rows[4]!.ticket = null; data.rows[5]!.repository = null; data.rows[6]!.repository = "[withheld]"; data.rows[7]!.ticket = null;
  await view.settle(data);
  const board = view.el("results"); assert.equal(board.withClass("repository-column").length, 4); assert.equal(board.withClass("ticket-card").length, 7);
  assert.equal(board.withClass("session-entry").length, 8); assert.match(view.el("count").textContent, /7 ticket groups · 4 repositories/);
  assert.ok(board.textContent.includes("Unknown repository")); assert.ok(board.textContent.includes("Repository withheld")); assert.ok(board.textContent.includes("No ticket"));
  const combined = board.withClass("ticket-card").find(card => card.withClass("session-entry").length === 2)!; assert.match(combined.textContent, /2 open/);
  for (const detail of [...board.withClass("sessions"), ...board.withClass("technical")]) assert.equal(detail.open, false);
  for (const field of ["Deployment", "Ticket", "Repository", "Team", "Mode", "Started", "Registry status", "Process", "Verified PID", "Location evidence"]) assert.ok(board.textContent.includes(field), field);
  assert.equal(board.descendants("table").length, 0);
});
test("compact objective previews remain per deployment on shared ticket cards; longer safe text stays in details", async () => {
  const view = client(), data = snapshot(2), long = "Check the dashboard view. ".repeat(15), hostile = "Render <img src=x onerror=alert(1)> as text";
  await view.settle(dashboardCapture(data, {
    "d-000000": { state: "available", preview: hostile, text: hostile, truncated: false },
    "d-000001": { state: "available", preview: long.slice(0, 180), text: long, truncated: true },
  }));
  const board = view.el("results"), previews = board.withClass("objective-preview"); assert.equal(previews.length, 2); assert.equal(board.withClass("ticket-card").length, 1);
  assert.deepEqual(previews.map(item => item.attributes.get("data-deployment")), ["d-000000", "d-000001"]);
  assert.ok(previews[0]!.textContent.includes(hostile)); assert.ok(!previews[1]!.textContent.includes(long)); assert.ok(previews[1]!.textContent.includes("…"));
  assert.ok(board.withClass("technical")[1]!.textContent.includes(long)); assert.ok(board.textContent.includes("[display text truncated]"));
  assert.equal(board.descendants("img").length, 0); assert.ok(board.withClass("technical").every(item => !item.open)); assert.match(view.el("objectives-observed").textContent, /separate from process verification/);
});
test("withheld/unavailable objective states never render stray source fields; refreshed metadata never reuses another deployment's text", async () => {
  const view = client(), data = snapshot(2);
  await view.settle(dashboardCapture(data, {
    "d-000000": { state: "withheld", reason: "sensitive-or-private", text: "must-not-render", preview: "must-not-render" } as unknown as SessionObjectivePreview,
    "d-000001": { state: "unavailable", reason: "not-recorded", text: "must-not-render" } as unknown as SessionObjectivePreview,
  }));
  assert.ok(!view.el("results").textContent.includes("must-not-render")); assert.match(view.el("results").textContent, /Objective withheld/); assert.match(view.el("results").textContent, /Objective unavailable/);
  const refresh = view.el("filters").fire("submit"); await view.settle(dashboardCapture(data, { "d-000000": { state: "available", preview: "First deployment task", text: "First deployment task", truncated: false } })); await refresh;
  const before = view.el("results").textContent, observed = view.el("objectives-observed").textContent;
  const failed = view.el("filters").fire("submit"); view.requests.at(-1)!.reject(new Error("private infrastructure")); await failed;
  assert.equal(view.el("results").textContent, before); assert.equal(view.el("objectives-observed").textContent, observed); assert.match(view.el("status").textContent, /Historical data/);
  const next = snapshot(); next.rows[0]!.deploymentId = "d-000009";
  const recovery = view.el("filters").fire("submit"); await view.settle(dashboardCapture(next)); await recovery;
  assert.ok(!view.el("results").textContent.includes("First deployment task")); assert.match(view.el("results").textContent, /Objective unavailable/);
});
test("off-page objective previews are not rendered until their own deployment page is selected", async () => {
  const view = client(), data = snapshot(101);
  await view.settle(dashboardCapture(data, { "d-000064": { state: "available", preview: "Only on the next page", text: "Only on the next page", truncated: false } }));
  assert.equal(view.el("results").withClass("objective-preview").length, 100); assert.ok(!view.el("results").textContent.includes("Only on the next page"));
  view.el("next").fire("click"); assert.equal(view.el("results").withClass("objective-preview").length, 1); assert.ok(view.el("results").textContent.includes("Only on the next page")); assert.equal(view.requests.length, 1);
});
test("local search/location filtering is capture-only, preserves applied server filters and distinguishes view-empty from capture-empty", async () => {
  const view = client(), data = snapshot(3);
  data.rows[0]!.herdr = { state: "qualified", location }; data.rows[1]!.herdr = { state: "unknown", reason: "herdr-coverage-incomplete" }; data.rows[2]!.ticket = "PAP-281";
  await view.settle(data); const applied = view.el("applied").textContent;
  view.el("search").value = "DaShBoArD"; view.el("search").fire("input"); assert.equal(view.el("results").withClass("session-entry").length, 1);
  view.el("location").value = "unknown"; view.el("location").fire("change"); assert.match(view.el("results").textContent, /No sessions match these view filters/);
  view.el("search").value = ""; view.el("search").fire("input"); assert.equal(view.el("results").withClass("session-entry").length, 1);
  assert.match(view.el("location-unknown").textContent, /Unknown \(1\)/); assert.equal(view.el("view-note").hidden, false);
  assert.equal(view.el("applied").textContent, applied); assert.equal(view.requests.length, 1);
  view.el("location").value = "all"; view.el("location").fire("change"); assert.equal(view.el("results").withClass("session-entry").length, 3);
});
test("stale and failed refresh keep historical cards, exact metadata and evidence, without polling or false freshness", async () => {
  const view = client(), data = snapshot(); data.coverage.complete = false; await view.settle(data);
  const before = view.el("results").textContent, capture = view.el("capture").textContent, coverage = view.el("coverage").textContent;
  view.setNow(61_000); assert.match(view.el("status").textContent, /Stale capture/); assert.equal(view.requests.length, 1); assert.match(view.el("capture-age").textContent, /1m/);
  const pending = view.el("filters").fire("submit"); view.requests[1]!.reject(new Error("private sensitive exception")); await pending;
  assert.match(view.el("status").textContent, /Historical data/); assert.ok(!view.el("status").textContent.includes("private")); assert.equal(view.el("results").textContent, before);
  assert.equal(view.el("capture").textContent, capture); assert.equal(view.el("coverage").textContent, coverage); assert.match(view.el("coverage-summary").textContent, /incomplete/);
  const invalid = view.el("filters").fire("submit"); await view.settle({ schemaVersion: "wrong" }); await invalid; assert.equal(view.el("results").textContent, before);
  const invalidRow = view.el("filters").fire("submit"); await view.settle({ ...snapshot(), rows: [null] }); await invalidRow; assert.equal(view.el("results").textContent, before);
  const recovery = view.el("filters").fire("submit"); const next = snapshot(0); next.capture.endedAt = new Date(61_000).toISOString(); await view.settle(next); await recovery;
  assert.match(view.el("status").textContent, /Capture loaded/); assert.match(view.el("results").textContent, /No matching/);
});
test("timeout restores controls and invalid exact filters explain correction without erasing data", async () => {
  const view = client(); view.timeouts.values().next().value!(); await view.flush();
  assert.match(view.el("status").textContent, /No capture is shown/); assert.equal(view.el("refresh").disabled, false); assert.equal(view.el("apply").disabled, false);
  const retry = view.el("filters").fire("submit"); view.requests[1]!.resolve({ ok: false, status: 400, json: async () => ({ error: "filters" }) }); await retry;
  assert.match(view.el("status").textContent, /Check the exact deployment/);
});
test("10,000 sessions in one ticket remain reachable with at most 100 rendered entries per page", async () => {
  const view = client(); await view.settle(snapshot(10_000));
  assert.equal(view.el("results").withClass("session-entry").length, 100); assert.equal(view.el("results").withClass("ticket-card").length, 1);
  assert.match(view.el("results").textContent, /100 of 10000 sessions shown/); assert.match(view.el("page").textContent, /Page 1 of 100/); assert.equal(view.el("pagination").hidden, false);
  const deployments = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const rows = view.el("results").withClass("session-entry"); assert.ok(rows.length <= 100);
    for (const row of rows) deployments.add(row.attributes.get("data-deployment")!);
    if (page < 99) view.el("next").fire("click");
  }
  assert.equal(view.el("results").withClass("objective-preview").length, 100);
  assert.equal(deployments.size, 10_000); assert.equal(view.el("next").disabled, true); assert.equal(view.requests.length, 1);
  view.el("search").value = "d-000001"; view.el("search").fire("input"); assert.match(view.el("page").textContent, /Page 1 of 1/); assert.equal(view.el("pagination").hidden, true);
});
test("ticket groups split across pages expose continuation and global group totals without duplicate or lost entries", async () => {
  const view = client(), data = snapshot(201); for (const row of data.rows.slice(150)) row.ticket = "PAP-287"; await view.settle(data);
  assert.match(view.el("results").textContent, /100 of 150 sessions shown/);
  view.el("next").fire("click"); const board = view.el("results"); assert.equal(board.withClass("ticket-card").length, 2); assert.equal(board.withClass("session-entry").length, 100);
  assert.match(board.textContent, /50 of 150 sessions shown/); assert.match(board.textContent, /50 of 51 sessions shown/);
  view.el("next").fire("click"); assert.equal(view.el("results").withClass("session-entry").length, 1);
});
test("all location states remain explicit, scoped identities stay exact and hostile labels render literally", async () => {
  const view = client(), data = snapshot(5);
  const hostile = { ...location, workspaceLabel: "Same label", tabLabel: "<img src=x onerror=alert(1)>" };
  data.rows[0]!.herdr = { state: "mapped", location: hostile }; data.rows[1]!.herdr = { state: "qualified", location: { ...hostile, session: "s2" } };
  data.rows[2]!.herdr = { state: "ambiguous", reason: "multiple-scoped-process-matches" }; data.rows[3]!.herdr = { state: "unknown", reason: "herdr-coverage-incomplete" };
  data.rows[4]!.process = { state: "identity-mismatch", reason: "pid-incarnation-changed" };
  data.filters.all = true; data.coverage = { complete: false, reasons: ["herdr-coverage-incomplete"], candidatesObserved: 7, diagnosticsOmitted: 2 };
  await view.settle(data); const board = view.el("results"), text = board.textContent;
  for (const value of ["Same label", "<img src=x onerror=alert(1)>", "uniqueness is not established", "Ambiguous", "Unknown", "Unmatched", "Candidate PID", "identity-mismatch", "No location selected", "Registry status", "Workspace ID", "Terminal ID", "2 observed workspaces"]) assert.ok(text.includes(value), value);
  assert.match(view.el("count").textContent, /5 candidates · 4 verified open/); assert.match(board.withClass("session-count")[0]!.textContent, /5 candidates · 4 open/);
  assert.match(view.el("coverage").textContent, /incomplete.*diagnostics omitted: 2/); assert.equal(board.descendants("img").length, 0);
  const badges = board.withClass("evidence-badges")[0]!.textContent; for (const state of ["Mapped", "Qualified", "Unknown", "Ambiguous", "Unmatched"]) assert.ok(badges.includes(state));
});
test("null repository/ticket buckets cannot collide with same-looking literal values or infer unknown workspace membership", async () => {
  const view = client(), data = snapshot(4);
  data.rows[0]!.repository = null; data.rows[1]!.repository = "Unknown repository"; data.rows[2]!.ticket = null; data.rows[3]!.ticket = "No ticket";
  for (const row of data.rows) row.herdr = { state: "unknown", reason: "herdr-coverage-incomplete" };
  await view.settle(data); const board = view.el("results"); assert.equal(board.withClass("repository-column").length, 3); assert.equal(board.withClass("ticket-card").length, 4);
  assert.equal(board.withClass("location-overview").every(item => item.textContent === "No verified location"), true);
  assert.ok(!board.textContent.includes("Workspace ID"));
});
