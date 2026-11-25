/** Offline-bundled assets. Data is fetched only from the dedicated same-origin reader.
 * Keep the browser script plain JavaScript so its exact delivered bytes are executable in tests. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local PPA session dashboard</title><link rel="stylesheet" href="/dashboard.css"><script src="/dashboard.js" defer></script></head>
<body><main><header><p class="eyebrow">Local · read-only · PPA/Pi</p><h1>Session <span>dashboard</span></h1>
<p>Open means alive, not actively working. Registry status is a separate recorded fact.</p>
<p class="notice">Local processes are trusted; there is no separate user authentication. Do not forward or publish this port. Locations describe a capture window, not a lock.</p></header>
<section aria-labelledby="filters-title"><h2 id="filters-title">Filter and refresh</h2>
<form id="filters"><label>Deployment (exact)<input id="deployment" maxlength="128" placeholder="d-123abc"></label>
<label>Ticket (exact)<input id="ticket" maxlength="128" placeholder="PAP-286"></label>
<label>Repository key (exact)<input id="repo" maxlength="128" placeholder="pa-platform"></label>
<label class="check"><input id="all" type="checkbox"> Include nonverified candidate diagnostics</label>
<button id="refresh" type="submit">Refresh capture</button></form>
<p>Filters intersect. Refresh reads fresh local evidence; changing grouping or pages does not collect again. No automatic refresh.</p>
<label>Group by <select id="group"><option value="herdr">HerdR session / workspace / tab</option><option value="repository">Repository</option><option value="ticket">Ticket</option></select></label>
<p id="status" role="status" aria-live="polite">No capture yet. Loading initial view…</p>
<p id="capture"></p><p id="coverage"></p><p id="applied"></p></section>
<section aria-labelledby="results-title"><h2 id="results-title">Observed sessions</h2><p id="count"></p>
<div class="pager"><button id="previous" type="button" disabled>Previous page</button><span id="page"></span><button id="next" type="button" disabled>Next page</button></div>
<div id="results"></div><noscript>JavaScript is required for refresh and grouping. Use ppa sessions for the same factual inventory.</noscript></section>
<footer>No session controls, terminal contents, objectives, arguments or environment. Nothing is saved by this dashboard. Use ppa sessions --help for collection limits.</footer></main></body></html>`;
export const DASHBOARD_CSS = `:root{color-scheme:light;font:16px/1.6 system-ui,sans-serif;color:#192d41;background:#f3f6fa}*{box-sizing:border-box}body{margin:0}main{max-width:1500px;margin:auto;padding:24px}header,section{background:white;border:1px solid #dee6ee;border-radius:16px;padding:24px;margin-bottom:20px}h1{font-size:42px;line-height:1.15;color:#123149;margin:8px 0 18px}h1 span{color:#287f87}.eyebrow{font-weight:650;text-transform:uppercase;font-size:12px}.notice{background:#fff7e3;border-left:4px solid #dca844;padding:14px}p,footer{max-width:92ch}form{display:flex;align-items:end;flex-wrap:wrap;gap:16px}label{display:block}input:not([type=checkbox]),select,button{display:block;font:inherit;padding:8px;max-width:100%;border:1px solid #536c80;border-radius:6px}input:not([type=checkbox]){width:220px}button{cursor:pointer;background:#123149;color:white}button:disabled{background:#eaf2f7;color:#536c80;cursor:default}.check{max-width:230px}.pager{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin:16px 0}.table-scroll{overflow:auto;max-width:100%}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #dee6ee;padding:8px;vertical-align:top;text-align:left;overflow-wrap:anywhere;min-width:100px}th{background:#eaf2f7}caption{text-align:left;font-weight:650;padding:10px 0}h3{overflow-wrap:anywhere}#status{font-weight:650;white-space:pre-line}#capture,#coverage,#applied{overflow-wrap:anywhere}:focus-visible{outline:3px solid #087a8b;outline-offset:3px}@media(max-width:700px){main{padding:12px}header,section{padding:16px}h1{font-size:32px}form{display:block}form label,form button{margin-bottom:14px}}@media print{body{background:white}main{max-width:none;padding:0}form,.pager,select{display:none}header,section{border:0;padding:8px}.table-scroll{overflow:visible}table{table-layout:fixed;font-size:9px}td,th{min-width:0;padding:3px}h2,h3{break-after:avoid}}`;
export const DASHBOARD_SCRIPT = String.raw`"use strict";
(() => {
  const el = id => document.getElementById(id);
  const form = el("filters"), status = el("status"), results = el("results");
  const pageSize = 100, staleMs = 60000;
  let snapshot = null, page = 0, busy = false, failed = false, sequence = 0;
  let failureHint = "Check the local server and retry Refresh capture when available.";
  const controls = ["deployment", "ticket", "repo", "all", "refresh"].map(el);
  function node(tag, text) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; }
  function age() { return snapshot ? Math.max(0, Date.now() - Date.parse(snapshot.capture.endedAt)) : 0; }
  function showStatus() {
    if (busy) status.textContent = snapshot ? "Refreshing. Displayed rows are the previous capture, not current observations." : "Loading initial capture. Please wait.";
    else if (failed) status.textContent = (snapshot ? "Refresh unavailable. Previous capture retained as historical data; it has not been reverified. " : "Session inventory unavailable. No capture is shown. ") + failureHint;
    else if (snapshot) status.textContent = age() >= staleMs ? "Stale capture (at least 60 seconds old). Rows have not been reverified. Select Refresh capture for a new observation." : "Capture loaded. Rows describe only the displayed capture window, not current activity. No action is required; refresh when you need a newer observation.";
  }
  function groupFor(row) {
    if (el("group").value === "repository") return [JSON.stringify([row.repository]), "Repository: " + (row.repository ?? "unknown")];
    if (el("group").value === "ticket") return [JSON.stringify([row.ticket]), "Ticket: " + (row.ticket ?? "unassociated")];
    const mapping = row.herdr;
    if (!("location" in mapping)) return [mapping.state, "No verified HerdR location (" + mapping.state + ")"];
    const loc = mapping.location;
    // Labels never identify groups: IDs are scoped by session, workspace and tab.
    return [JSON.stringify([loc.session, loc.workspaceId, loc.tabId]), "HerdR session " + loc.session + " / workspace " + (loc.workspaceLabel ?? "unlabelled") + " [" + loc.workspaceId + "] / tab " + (loc.tabLabel ?? "unlabelled") + " [" + loc.tabId + "]"];
  }
  function values(row) {
    const mapping = row.herdr, process = row.process;
    const loc = "location" in mapping ? mapping.location : null;
    return [row.deploymentId, row.ticket ?? "—", (row.team ?? "—") + "/" + (row.mode ?? "—"), row.repository ?? "unknown", row.startedAt ?? "unknown", row.registryStatus ?? "unknown",
      process.state + ("reason" in process ? ": " + process.reason : ""), process.state === "verified-open" ? String(process.pid) : "candidate: " + (row.candidatePid ?? "unknown"),
      mapping.state === "qualified" ? "qualified: observed with HerdR coverage incomplete; uniqueness is not established" : mapping.state + ("reason" in mapping ? ": " + mapping.reason : ""),
      loc ? "Session " + loc.session + " / workspace " + loc.workspaceId + " / tab " + loc.tabId + " / pane " + loc.paneId + " / terminal " + loc.terminalId : "No location selected"];
  }
  function render() {
    results.replaceChildren();
    if (!snapshot) return;
    el("capture").textContent = "Capture: " + snapshot.capture.startedAt + " to " + snapshot.capture.endedAt + ". Scope: " + snapshot.scope + ".";
    el("coverage").textContent = "Coverage: " + (snapshot.coverage.complete ? "complete within scope" : "incomplete") + "; candidates observed: " + snapshot.coverage.candidatesObserved + "; diagnostics omitted: " + snapshot.coverage.diagnosticsOmitted + "." + (snapshot.coverage.reasons.length ? " Limitations: " + snapshot.coverage.reasons.join(", ") + "." : "") + (snapshot.coverage.diagnosticsOmitted ? " Include nonverified candidate diagnostics for a broader view; missing launch evidence does not prove exit." : "");
    el("applied").textContent = "Applied capture filters: " + JSON.stringify(snapshot.filters) + ". Input changes apply only on Refresh capture.";
    const groups = new Map();
    for (const row of snapshot.rows) {
      const [key, label] = groupFor(row);
      if (!groups.has(key)) groups.set(key, { label, rows: [] });
      groups.get(key).rows.push(row);
    }
    const ordered = [...groups].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, group]) => group.rows.sort((a, b) => a.deploymentId.localeCompare(b.deploymentId)).map(row => ({ key, label: group.label, row })));
    const pages = Math.max(1, Math.ceil(ordered.length / pageSize)); page = Math.max(0, Math.min(page, pages - 1));
    el("count").textContent = ordered.length + (snapshot.filters.all ? " candidates" : " verified-open processes") + "; " + groups.size + " groups. Open is not actively working.";
    el("page").textContent = "Page " + (page + 1) + " of " + pages + "; at most " + pageSize + " rows per page.";
    el("previous").disabled = page === 0; el("next").disabled = page + 1 >= pages;
    if (!ordered.length) { results.append(node("p", "No matching sessions are shown. No action is required. Remove filters or include diagnostics for a broader view.")); return; }
    let lastKey, table;
    for (const { key, label, row } of ordered.slice(page * pageSize, (page + 1) * pageSize)) {
      if (key !== lastKey) {
        lastKey = key; results.append(node("h3", label));
        const wrap = node("div"); wrap.className = "table-scroll"; wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", label + "; scroll horizontally if needed");
        table = node("table"); table.append(node("caption", label + " — page " + (page + 1)));
        const head = node("thead"), tr = node("tr");
        for (const title of ["Deployment", "Ticket", "Team/mode", "Repository", "Started", "Registry status", "Process state", "PID", "Location evidence", "Scoped location"]) { const th = node("th", title); th.setAttribute("scope", "col"); tr.append(th); }
        head.append(tr); table.append(head); table.append(node("tbody")); wrap.append(table); results.append(wrap);
      }
      const tr = node("tr"); for (const value of values(row)) tr.append(node("td", value)); table.lastChild.append(tr);
    }
  }
  async function refresh(event) {
    if (event) event.preventDefault();
    if (busy) return;
    failureHint = "Check the local server and retry Refresh capture when available.";
    busy = true; const current = ++sequence; showStatus(); controls.forEach(control => { control.disabled = true; });
    const params = new URLSearchParams();
    for (const key of ["deployment", "ticket", "repo"]) if (el(key).value.trim()) params.set(key, el(key).value.trim());
    params.set("all", String(el("all").checked));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16000);
    try {
      const reply = await fetch("/v1/sessions?" + params, { method: "GET", headers: { "X-PPA-Sessions": "1" }, cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
      if (!reply.ok) {
        if (reply.status === 400) failureHint = "Check the exact deployment, ticket and repository-key filters, then retry Refresh capture. Paths and duplicate filters are not supported.";
        else if (reply.status === 503) failureHint = "The collector is busy or local evidence is unavailable. Wait for any in-flight capture to finish, then retry; ask the runtime maintainer if this persists.";
        throw new Error("unavailable");
      }
      const next = await reply.json();
      if (next.schemaVersion !== "ppa-sessions/v1" || !Array.isArray(next.rows) || !Number.isFinite(Date.parse(next.capture.endedAt))) throw new Error("invalid capture");
      if (current !== sequence) return;
      snapshot = next; page = 0; failed = false; render();
    } catch {
      if (current === sequence) failed = true;
    } finally {
      clearTimeout(timer);
      if (current === sequence) { busy = false; controls.forEach(control => { control.disabled = false; }); showStatus(); }
    }
  }
  form.addEventListener("submit", refresh);
  el("group").addEventListener("change", () => { page = 0; render(); });
  el("previous").addEventListener("click", () => { page--; render(); });
  el("next").addEventListener("click", () => { page++; render(); });
  // Age the label only; this interval never collects data.
  setInterval(showStatus, 1000);
  refresh();
})();`;
