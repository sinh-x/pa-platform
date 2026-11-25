import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_SCRIPT } from "../session-dashboard-page.js";
import type { SessionSnapshot } from "../session-capture.js";

/** Minimal DOM contract fixture, not a browser/keyboard/layout observation. */
class Element {
  children: Element[] = []; ownText = ""; value = ""; checked = false; disabled = false; className = ""; tabIndex = 0;
  attributes = new Map<string, string>(); listeners = new Map<string, (event?: { preventDefault(): void }) => unknown>();
  constructor(readonly tag: string) {}
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(" "); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }
  set innerHTML(_value: string) { throw new Error("Unsafe HTML insertion"); }
  get lastChild(): Element { return this.children.at(-1)!; }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.ownText = ""; this.children = items; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(event: string, fn: (event?: { preventDefault(): void }) => unknown) { this.listeners.set(event, fn); }
  fire(event: string) { return this.listeners.get(event)?.({ preventDefault() {} }); }
  descendants(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.descendants(tag)]); }
}
function snapshot(count = 1): SessionSnapshot {
  return { schemaVersion: "ppa-sessions/v1", scope: "local-linux-ppa-pi-existing-launch-evidence", capture: { startedAt: new Date(0).toISOString(), endedAt: new Date(1000).toISOString() }, filters: { all: false },
    coverage: { complete: true, reasons: [], candidatesObserved: count, diagnosticsOmitted: 0 }, rows: Array.from({ length: count }, (_, i) => ({ deploymentId: `d-${i.toString(16).padStart(6, "0")}`, ticket: "PAP-286", team: "rogue-one", mode: "rogue-one", repository: "project", startedAt: null, registryStatus: "success", candidatePid: 42, process: { state: "verified-open", pid: 42 }, herdr: { state: "unmatched", reason: "no-foreground-ancestry-match" } })) };
}
function client() {
  const elements = new Map([...DASHBOARD_HTML.matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element(match[1]!)]));
  elements.get("group")!.value = "herdr";
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
  async function settle(data: unknown, index = requests.length - 1) { requests[index]!.resolve({ ok: true, json: async () => data }); await flush(); }
  async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
  return { el, requests, settle, flush, intervals, timeouts, setNow: (time: number) => { now = time; intervals.forEach(fn => fn()); } };
}
test("bundled page has semantic labels, no remote assets or inline executable content", () => {
  assert.equal((DASHBOARD_HTML.match(/<h1>/g) ?? []).length, 1);
  for (const id of ["deployment", "ticket", "repo", "all", "group", "refresh", "status", "capture", "coverage", "applied", "results", "previous", "next"]) assert.ok(DASHBOARD_HTML.includes(`id="${id}"`));
  assert.match(DASHBOARD_HTML, /aria-live="polite"/); assert.match(DASHBOARD_HTML, /No automatic refresh/);
  assert.ok(!/https?:|\son\w+=|<script(?! src=)/.test(DASHBOARD_HTML));
  assert.ok(!/innerHTML|localStorage|sessionStorage|WebSocket|EventSource|window\.open/.test(DASHBOARD_SCRIPT));
  assert.match(DASHBOARD_CSS, /:focus-visible/); assert.match(DASHBOARD_CSS, /@media print/);
});
test("initial loading, one flight, exact refresh params, regrouping without collection and empty results", async () => {
  const view = client();
  assert.equal(view.requests.length, 1); assert.match(view.el("status").textContent, /Loading initial/); assert.equal(view.el("refresh").disabled, true);
  await view.el("filters").fire("submit"); assert.equal(view.requests.length, 1);
  await view.settle(snapshot(0)); assert.match(view.el("results").textContent, /No matching/); assert.equal(view.el("refresh").disabled, false);
  view.el("ticket").value = "PAP-286"; view.el("repo").value = "project"; view.el("all").checked = true;
  const pending = view.el("filters").fire("submit"); assert.equal(view.requests[1]!.url, "/v1/sessions?ticket=PAP-286&repo=project&all=true");
  assert.equal(view.requests[1]!.options.credentials, "omit"); assert.equal(view.requests[1]!.options.redirect, "error");
  assert.match(view.el("status").textContent, /previous capture/);
  const data = snapshot(); data.filters = { all: true, ticket: "PAP-286", repo: "project" };
  await view.settle(data); await pending;
  view.el("group").value = "ticket"; view.el("group").fire("change"); assert.equal(view.requests.length, 2); assert.match(view.el("results").textContent, /Ticket: PAP-286/);
  assert.match(view.el("applied").textContent, /"all":true/);
});
test("stale labels age without polling; failed/invalid captures preserve old rows and exact capture metadata", async () => {
  const view = client(); await view.settle(snapshot());
  const before = view.el("results").textContent, capture = view.el("capture").textContent;
  view.setNow(61_000); assert.match(view.el("status").textContent, /Stale capture/); assert.equal(view.requests.length, 1);
  const pending = view.el("filters").fire("submit"); view.requests[1]!.reject(new Error("private sensitive exception")); await pending;
  assert.match(view.el("status").textContent, /historical data/); assert.ok(!view.el("status").textContent.includes("private"));
  assert.equal(view.el("results").textContent, before); assert.equal(view.el("capture").textContent, capture);
  const invalid = view.el("filters").fire("submit"); await view.settle({ schemaVersion: "wrong" }); await invalid;
  assert.equal(view.el("results").textContent, before); assert.match(view.el("status").textContent, /not been reverified/);
  const recovery = view.el("filters").fire("submit"); const next = snapshot(0); next.capture.endedAt = new Date(61_000).toISOString(); await view.settle(next); await recovery;
  assert.match(view.el("status").textContent, /Capture loaded/); assert.match(view.el("results").textContent, /No matching/);
});
test("timeout restores controls and leaves no fresh claim; invalid filter response gives correction", async () => {
  const view = client(); view.timeouts.values().next().value!(); await view.flush();
  assert.match(view.el("status").textContent, /No capture is shown/); assert.equal(view.el("refresh").disabled, false);
  const retry = view.el("filters").fire("submit"); view.requests[1]!.resolve({ ok: false, status: 400, json: async () => ({ error: "filters" }) }); await retry;
  assert.match(view.el("status").textContent, /Check the exact deployment/);
});
test("10,000 rows paginate without loss; regroup resets page and never refetches", async () => {
  const view = client(); await view.settle(snapshot(10_000));
  assert.equal(view.el("results").descendants("tbody").flatMap(body => body.children).length, 100); assert.match(view.el("page").textContent, /Page 1 of 100/);
  const deployments = new Set<string>();
  for (let page = 0; page < 100; page++) {
    for (const body of view.el("results").descendants("tbody")) for (const row of body.children) deployments.add(row.children[0]!.textContent);
    if (page < 99) view.el("next").fire("click");
  }
  assert.equal(deployments.size, 10_000); assert.equal(view.el("next").disabled, true); assert.equal(view.requests.length, 1);
  view.el("group").value = "repository"; view.el("group").fire("change"); assert.match(view.el("page").textContent, /Page 1 of 100/);
});
test("scoped HerdR groups, qualified/unmapped/ambiguous states, PID diagnostics and hostile text stay literal", async () => {
  const view = client(), data = snapshot(5);
  const location = { session: "s1", workspaceId: "w1", workspaceLabel: "Same label", tabId: "t1", tabLabel: "<img src=x onerror=alert(1)>", paneId: "p1", terminalId: "term1" };
  data.rows[0]!.herdr = { state: "mapped", location };
  data.rows[1]!.herdr = { state: "qualified", location: { ...location, session: "s2" } };
  data.rows[2]!.herdr = { state: "ambiguous", reason: "multiple-scoped-process-matches" };
  data.rows[3]!.herdr = { state: "unknown", reason: "herdr-coverage-incomplete" };
  data.rows[4]!.process = { state: "identity-mismatch", reason: "pid-incarnation-changed" };
  data.filters.all = true; data.coverage = { complete: false, reasons: ["herdr-coverage-incomplete"], candidatesObserved: 7, diagnosticsOmitted: 2 };
  await view.settle(data);
  const text = view.el("results").textContent;
  for (const value of ["Same label", "<img src=x onerror=alert(1)>", "uniqueness is not established", "ambiguous", "unknown", "candidate: 42", "identity-mismatch", "No location selected", "Registry status"]) assert.ok(text.includes(value), value);
  assert.equal(view.el("results").descendants("h3").length, 5);
  assert.match(view.el("coverage").textContent, /incomplete.*diagnostics omitted: 2/); assert.equal(view.el("results").descendants("img").length, 0);
});
