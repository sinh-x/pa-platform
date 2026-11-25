/** Offline-bundled ticket-first reader of the unchanged ppa-sessions/v1 projection.
 * Keep the browser script plain JavaScript so tests execute the delivered bytes. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local PPA session dashboard</title><link rel="stylesheet" href="/dashboard.css"><script src="/dashboard.js" defer></script></head>
<body><main><header class="toolbar"><div><h1>Sessions</h1><p id="count">Loading capture…</p></div>
<label class="search">Search this capture<input id="search" type="search" maxlength="128" placeholder="Ticket, repository, tab or team"></label>
<span id="capture-age" class="muted">No capture yet</span><span id="coverage-summary" class="badge unknown">Coverage pending</span>
<button id="refresh" type="submit" form="filters">↻ Refresh capture</button></header>
<section class="controls" aria-label="View and capture controls"><div class="view-tools"><label>Location <select id="location"><option id="location-all" value="all">All locations</option><option id="location-mapped" value="mapped">Mapped</option><option id="location-qualified" value="qualified">Qualified</option><option id="location-unknown" value="unknown">Unknown</option><option id="location-ambiguous" value="ambiguous">Ambiguous</option><option id="location-unmatched" value="unmatched">Unmatched</option></select></label>
<details id="capture-details" class="capture-details"><summary>Capture &amp; exact filters</summary>
<form id="filters"><label>Deployment (exact)<input id="deployment" maxlength="128" placeholder="d-123abc"></label><label>Ticket (exact)<input id="ticket" maxlength="128" placeholder="PAP-286"></label><label>Repository key (exact)<input id="repo" maxlength="128" placeholder="pa-platform"></label><label class="check"><input id="all" type="checkbox"> Include nonverified candidate diagnostics</label><button id="apply" type="submit">Apply &amp; refresh</button></form>
<p>Exact filters intersect and apply only on refresh. Search and Location filter this saved capture without collection. No automatic refresh.</p><p id="capture"></p><p id="coverage"></p><p id="applied"></p><p id="objectives-observed"></p></details></div>
<p id="status" role="status" aria-live="polite">Loading initial capture…</p><p class="legend">Open means alive, not actively working. Qualified = directly rechecked location with incomplete HerdR coverage; uniqueness is not established.</p></section>
<section aria-labelledby="results-title"><h2 id="results-title" class="sr-only">Sessions by repository and ticket</h2><p id="view-note" class="muted" hidden></p><div id="results" class="repository-board"></div>
<div id="pagination" class="pager" hidden><button id="previous" type="button" disabled>Previous page</button><span id="page"></span><button id="next" type="button" disabled>Next page</button></div>
<noscript>JavaScript is required for this view. Use ppa sessions for the same factual inventory.</noscript></section>
<footer>Read-only · Local processes are trusted; no separate user authentication. Do not forward or publish this port. No session controls or terminal contents.</footer></main></body></html>`;
export const DASHBOARD_CSS = `:root{color-scheme:light;font:14px/1.5 system-ui,-apple-system,sans-serif;color:#203548;background:#f1f5f8;--line:#dce5ed;--muted:#596f81;--teal:#11777c;--navy:#15344a}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0}main{max-width:1660px;margin:auto;padding:20px}h1{font-size:25px;letter-spacing:-.03em;line-height:1.2;margin:0;color:var(--navy)}h2,h3,p{margin:0}h2{font-size:15px}h3{font-size:14px}input,select,button{font:inherit;padding:7px 10px;border:1px solid #bdcdd9;border-radius:6px;background:#fff;color:#203548;max-width:100%}button{cursor:pointer;background:var(--teal);color:white;border-color:var(--teal);white-space:nowrap}button:disabled{cursor:default;background:#e7eef3;color:#5b7183;border-color:var(--line)}input:not([type=checkbox]){display:block;width:210px}label{font-size:12px;color:var(--muted)}.toolbar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:white;border:1px solid var(--line);border-radius:10px 10px 0 0;padding:14px 18px}.toolbar>div{margin-right:auto}.toolbar #count{font-size:12px;color:var(--muted);margin-top:4px}.search{font-size:11px}.search input{width:270px}.muted{color:var(--muted);font-size:12px}.badge{display:inline-block;font-size:11px;font-weight:650;padding:2px 7px;border:1px solid var(--line);border-radius:4px;white-space:nowrap}.qualified{color:#75500b;background:#fff2d7;border-color:#e8d2a4}.mapped,.open{color:#1d6b5e;background:#e4f2ed;border-color:#c9e4d9}.unknown,.unmatched{color:#4a5d6e;background:#edf1f5;border-color:#d6dfe8}.ambiguous,.diagnostic{color:#8a3c2d;background:#fff0e8;border-color:#eed2c1}.controls{background:#fff;border:1px solid var(--line);border-top:0;border-radius:0 0 10px 10px;padding:10px 18px;margin-bottom:18px}.view-tools{display:flex;gap:18px;align-items:center;flex-wrap:wrap}.view-tools>label{display:flex;align-items:center;gap:7px}.capture-details{margin-left:auto;color:var(--muted);font-size:12px}.capture-details[open]{flex-basis:100%;margin:4px 0}.capture-details summary{cursor:pointer;font-weight:600}.capture-details p{margin-top:8px;overflow-wrap:anywhere}.capture-details form{display:flex;align-items:end;flex-wrap:wrap;gap:12px;padding:12px 0}.check{max-width:190px}#status{font-size:12px;font-weight:600;margin-top:9px}#status[data-state=failed],#status[data-state=stale]{color:#7a4c08}.legend{font-size:11px;color:var(--muted);margin-top:5px}.repository-board{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:16px;align-items:start}.repository-column{min-width:0}.repository-heading{display:flex;gap:8px;justify-content:space-between;align-items:baseline;margin:0 2px 10px}.repository-heading h2{overflow-wrap:anywhere}.repository-heading p{font-size:11px;color:var(--muted);white-space:nowrap}.ticket-card{background:white;border:1px solid var(--line);border-radius:9px;padding:12px 14px;margin-bottom:10px;min-width:0}.card-heading{display:flex;gap:10px;justify-content:space-between;align-items:baseline}.card-heading h3{overflow-wrap:anywhere}.session-count{color:var(--muted);font-size:11px;white-space:nowrap}.card-label{font-size:12px;color:#536c80;margin:4px 0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card-bottom{display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap}.location-overview{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.evidence-badges{display:flex;gap:4px;flex-wrap:wrap}.sessions{font-size:12px;margin-top:9px;border-top:1px solid #edf1f5;padding-top:7px}.sessions>summary{font-weight:600;cursor:pointer;color:var(--teal)}.session-entry{padding:10px 0;border-top:1px solid #edf1f5}.session-entry:first-of-type{margin-top:7px}.session-heading{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.session-heading strong{overflow-wrap:anywhere}.session-entry .location-path{font-size:11px;margin:5px 0;color:var(--muted);overflow-wrap:anywhere}.technical{font-size:11px;color:var(--muted);margin-top:6px}.technical summary{cursor:pointer}.technical dl{display:grid;grid-template-columns:105px minmax(0,1fr);gap:5px 9px;margin:10px 0}.technical dt{font-weight:600}.technical dd{margin:0;overflow-wrap:anywhere}.objective-previews{list-style:none;margin:9px 0 0;padding:0}.objective-preview{display:flex;gap:8px;align-items:baseline;min-width:0;padding:6px 0;border-top:1px solid #edf1f5}.objective-owner{display:block;flex:0 0 auto;max-width:45%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:10px}.objective-line{display:block;flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.objective-line.withheld,.objective-line.unavailable{color:var(--muted);font-style:italic}.continuation{font-size:11px;color:#785312;margin-top:7px}.pager{display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;margin:18px 0;font-size:12px}#view-note{margin-bottom:12px}.empty{grid-column:1/-1;background:white;border:1px solid var(--line);border-radius:9px;padding:20px;color:var(--muted)}footer{font-size:11px;color:var(--muted);margin-top:18px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}:focus-visible{outline:3px solid #168b96;outline-offset:3px}@media(max-width:700px){main{padding:10px}.toolbar{padding:12px;gap:10px}.toolbar>div{width:100%}.search{flex:1}.search input{width:100%}.controls{padding:10px 12px}.view-tools{gap:10px}.capture-details{margin-left:0}.capture-details form{display:block}.capture-details form label,.capture-details form button{display:block;margin:10px 0}.repository-board{grid-template-columns:1fr}.toolbar #refresh{margin-left:auto}}@media print{body{background:white}main{max-width:none;padding:0}.toolbar{border:0;padding:0}.toolbar .search,.toolbar button,.view-tools,.pager{display:none}.controls{border:0;padding:8px 0}.repository-board{display:block}.repository-column{margin-bottom:16px}.ticket-card{break-inside:avoid}.sessions>summary,.technical>summary{font-weight:600}details::details-content{display:block;content-visibility:visible;height:auto}.card-label{white-space:normal}.repository-heading{break-after:avoid}}`;
export const DASHBOARD_SCRIPT = String.raw`"use strict";
(() => {
  const el = id => document.getElementById(id);
  const form = el("filters"), status = el("status"), results = el("results");
  const pageSize = 100, staleMs = 60000;
  const locationNames = { mapped: "Mapped", qualified: "Qualified", unknown: "Unknown", ambiguous: "Ambiguous", unmatched: "Unmatched" };
  let snapshot = null, objectiveMetadata = null, page = 0, busy = false, failed = false;
  let view = { ordered: [], repositories: [], ticketCount: 0 };
  let failureHint = "Check the local server, then retry Refresh capture.";
  const controls = ["deployment", "ticket", "repo", "all", "refresh", "apply"].map(el);
  function node(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
  function badge(text, state) { return node("span", text, "badge " + state); }
  function age() { return snapshot ? Math.max(0, Date.now() - Date.parse(snapshot.capture.endedAt)) : 0; }
  function showStatus() {
    const seconds = Math.floor(age() / 1000);
    el("capture-age").textContent = snapshot ? "Captured " + (seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m") + " ago" : "No capture yet";
    status.setAttribute("data-state", busy ? "loading" : failed ? "failed" : snapshot && age() >= staleMs ? "stale" : "loaded");
    if (busy) status.textContent = snapshot ? "Refreshing. Displayed sessions are the previous capture, not current observations." : "Loading initial capture. Please wait.";
    else if (failed) status.textContent = (snapshot ? "Refresh unavailable. Historical data retained; it has not been reverified. " : "Session inventory unavailable. No capture is shown. ") + failureHint;
    else if (snapshot) status.textContent = age() >= staleMs ? "Stale capture (at least 60 seconds old). Refresh to reverify." : "Capture loaded. Observed during its capture window, not live activity.";
  }
  const repositoryLabel = value => value === null ? "Unknown repository" : value === "[withheld]" ? "Repository withheld" : value;
  const ticketLabel = value => value === null ? "No ticket" : value === "[withheld]" ? "Ticket withheld" : value;
  function buildView(capture) {
    const repositories = new Map(), query = el("search").value.trim().slice(0, 128).toLowerCase(), location = el("location").value;
    for (const row of capture.rows) {
      if (!row || typeof row.deploymentId !== "string" || !row.process || !row.herdr) throw new Error("invalid row");
      const loc = "location" in row.herdr ? row.herdr.location : null;
      const searchable = [row.deploymentId, row.ticket, row.repository, row.team, row.mode, loc?.session, loc?.workspaceLabel, loc?.tabLabel].filter(Boolean).join(" ").toLowerCase();
      if ((query && !searchable.includes(query)) || (location !== "all" && row.herdr.state !== location)) continue;
      // Exact serialized keys keep null/withheld buckets separate from literal keys.
      const repoKey = JSON.stringify(row.repository), key = JSON.stringify([row.repository, row.ticket]);
      if (!repositories.has(repoKey)) repositories.set(repoKey, { key: repoKey, label: repositoryLabel(row.repository), tickets: new Map(), count: 0 });
      const repo = repositories.get(repoKey);
      if (!repo.tickets.has(key)) repo.tickets.set(key, { key, label: ticketLabel(row.ticket), rows: [] });
      repo.tickets.get(key).rows.push(row); repo.count++;
    }
    const sorted = [...repositories.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
    const ordered = []; let ticketCount = 0;
    for (const repo of sorted) {
      repo.sortedTickets = [...repo.tickets.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
      ticketCount += repo.sortedTickets.length;
      for (const ticket of repo.sortedTickets) {
        ticket.rows.sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
        for (const row of ticket.rows) ordered.push({ repo, ticket, row });
      }
    }
    return { ordered, repositories: sorted, ticketCount };
  }
  function objectiveFor(row) {
    const value = objectiveMetadata?.byDeployment?.[row.deploymentId];
    if (value?.state === "withheld") return { state: "withheld", text: "Objective withheld by privacy screening." };
    if (value?.state === "available" && typeof value.preview === "string" && value.preview.length <= 180 && typeof value.text === "string" && value.text.length <= 1024 && value.text.startsWith(value.preview)) return value;
    return { state: "unavailable", text: "Objective unavailable: not recorded or metadata could not be read/screened." };
  }
  function sessionDetails(row) {
    const item = node("div", undefined, "session-entry"); item.setAttribute("data-deployment", row.deploymentId);
    const mapping = row.herdr, loc = "location" in mapping ? mapping.location : null;
    const heading = node("div", undefined, "session-heading");
    const team = row.team === row.mode ? row.team : [row.team ?? "unknown team", row.mode ?? "unknown mode"].join(" / ");
    heading.append(node("strong", team ?? "Unknown team"), badge(row.process.state === "verified-open" ? "Verified open" : row.process.state, row.process.state === "verified-open" ? "open" : "diagnostic"), badge(locationNames[mapping.state] ?? "Unknown", mapping.state));
    item.append(heading);
    item.append(node("p", loc ? loc.session + " / " + (loc.workspaceLabel ?? loc.workspaceId) + " / " + (loc.tabLabel ?? loc.tabId) + " / pane " + loc.paneId : "No location selected: " + mapping.state, "location-path"));
    const details = node("details", undefined, "technical"), facts = node("dl"); details.append(node("summary", "Identifiers & evidence"));
    const add = (label, value) => { facts.append(node("dt", label), node("dd", value ?? "unknown")); };
    const objective = objectiveFor(row);
    add("Recorded objective", objective.text + (objective.state === "available" && objective.truncated ? " [display text truncated]" : ""));
    add("Deployment", row.deploymentId); add("Ticket", row.ticket ?? "unassociated"); add("Repository", row.repository);
    add("Team", row.team); add("Mode", row.mode); add("Started", row.startedAt); add("Registry status", row.registryStatus);
    add("Process", row.process.state + ("reason" in row.process ? ": " + row.process.reason : ""));
    add(row.process.state === "verified-open" ? "Verified PID" : "Candidate PID", String(row.process.state === "verified-open" ? row.process.pid : row.candidatePid ?? "unknown"));
    add("Location evidence", mapping.state === "qualified" ? "Qualified: directly rechecked with HerdR coverage incomplete; uniqueness is not established." : mapping.state + ("reason" in mapping ? ": " + mapping.reason : ""));
    if (loc) for (const [label, value] of [["HerdR session", loc.session], ["Workspace ID", loc.workspaceId], ["Workspace label", loc.workspaceLabel], ["Tab ID", loc.tabId], ["Tab label", loc.tabLabel], ["Pane ID", loc.paneId], ["Terminal ID", loc.terminalId]]) add(label, value);
    details.append(facts); item.append(details); return item;
  }
  function ticketCard(ticket, rows) {
    const card = node("article", undefined, "ticket-card"); card.setAttribute("data-ticket-key", ticket.key);
    const heading = node("div", undefined, "card-heading"), count = ticket.rows.length;
    const open = ticket.rows.filter(row => row.process.state === "verified-open").length;
    heading.append(node("h3", ticket.label), node("span", snapshot.filters.all ? count + " candidates · " + open + " open" : count + " open", "session-count")); card.append(heading);
    const labels = [...new Set(ticket.rows.map(row => "location" in row.herdr ? row.herdr.location.tabLabel ?? row.herdr.location.tabId : "No verified tab"))];
    const label = node("p", labels.slice(0, 2).join(" · ") + (labels.length > 2 ? " · +" + (labels.length - 2) + " more tabs" : ""), "card-label"); card.append(label);
    const workspaces = new Map(), counts = new Map();
    for (const row of ticket.rows) {
      counts.set(row.herdr.state, (counts.get(row.herdr.state) ?? 0) + 1);
      if ("location" in row.herdr) { const loc = row.herdr.location; workspaces.set(JSON.stringify([loc.session, loc.workspaceId]), loc.session + " / " + (loc.workspaceLabel ?? loc.workspaceId)); }
    }
    const bottom = node("div", undefined, "card-bottom"), badges = node("div", undefined, "evidence-badges");
    bottom.append(node("span", workspaces.size === 1 ? "Observed: " + [...workspaces.values()][0] : workspaces.size ? workspaces.size + " observed workspaces" : "No verified location", "location-overview"));
    for (const state of Object.keys(locationNames)) if (counts.has(state)) badges.append(badge(locationNames[state] + (count > 1 ? " · " + counts.get(state) : ""), state));
    bottom.append(badges); card.append(bottom);
    const previews = node("ul", undefined, "objective-previews");
    for (const row of rows) {
      const objective = objectiveFor(row), preview = node("li", undefined, "objective-preview"); preview.setAttribute("data-deployment", row.deploymentId);
      preview.append(node("span", (row.team ?? "Unknown team") + " · " + row.deploymentId, "objective-owner"));
      preview.append(node("span", objective.state === "available" ? "Objective: " + objective.preview + (objective.text.length > objective.preview.length || objective.truncated ? "…" : "") : objective.state === "withheld" ? "Objective withheld (privacy screen)" : "Objective unavailable", "objective-line " + objective.state));
      previews.append(preview);
    }
    card.append(previews);
    const sessions = node("details", undefined, "sessions"); sessions.append(node("summary", "Sessions (" + count + ")"));
    if (rows.length < count) card.append(node("p", rows.length + " of " + count + " sessions shown on this page; use Previous/Next for the rest.", "continuation"));
    for (const row of rows) sessions.append(sessionDetails(row));
    card.append(sessions); return card;
  }
  function render() {
    results.replaceChildren(); if (!snapshot) return;
    const total = view.ordered.length, pages = Math.max(1, Math.ceil(total / pageSize)); page = Math.max(0, Math.min(page, pages - 1));
    const open = view.ordered.filter(item => item.row.process.state === "verified-open").length;
    el("count").textContent = (snapshot.filters.all ? total + " candidates · " + open + " verified open" : total + " verified open") + " · " + view.ticketCount + " ticket groups · " + view.repositories.length + " repositories";
    el("page").textContent = "Page " + (page + 1) + " of " + pages + " · at most " + pageSize + " sessions per page";
    el("pagination").hidden = pages <= 1; el("previous").disabled = page === 0; el("next").disabled = page + 1 >= pages;
    const filtered = el("search").value.trim() || el("location").value !== "all";
    el("view-note").hidden = !filtered;
    el("view-note").textContent = total + " of " + snapshot.rows.length + " captured rows match the view filters. Search and Location do not recapture.";
    if (!total) { results.append(node("p", snapshot.rows.length ? "No sessions match these view filters. Clear Search or choose All locations to broaden the view." : "No matching sessions in this capture. No action is required; remove exact filters or include diagnostics for a broader view.", "empty")); return; }
    const visible = new Map();
    for (const item of view.ordered.slice(page * pageSize, (page + 1) * pageSize)) {
      if (!visible.has(item.repo.key)) visible.set(item.repo.key, { repo: item.repo, tickets: new Map(), count: 0 });
      const group = visible.get(item.repo.key); group.count++;
      if (!group.tickets.has(item.ticket.key)) group.tickets.set(item.ticket.key, { ticket: item.ticket, rows: [] });
      group.tickets.get(item.ticket.key).rows.push(item.row);
    }
    for (const { repo, tickets, count } of visible.values()) {
      const column = node("section", undefined, "repository-column"); column.setAttribute("aria-label", repo.label);
      const heading = node("div", undefined, "repository-heading"); heading.append(node("h2", repo.label), node("p", repo.count + " sessions" + (count < repo.count ? " · " + count + " on page" : ""))); column.append(heading);
      for (const { ticket, rows } of tickets.values()) column.append(ticketCard(ticket, rows));
      results.append(column);
    }
  }
  function updateCaptureMetadata() {
    el("capture").textContent = "Capture: " + snapshot.capture.startedAt + " to " + snapshot.capture.endedAt + ". Scope: " + snapshot.scope + ".";
    el("coverage-summary").textContent = snapshot.coverage.complete ? "Coverage complete within scope" : "Coverage incomplete";
    el("coverage-summary").className = "badge " + (snapshot.coverage.complete ? "mapped" : "qualified");
    el("coverage").textContent = "Coverage: " + (snapshot.coverage.complete ? "complete within scope" : "incomplete") + "; candidates observed: " + snapshot.coverage.candidatesObserved + "; diagnostics omitted: " + snapshot.coverage.diagnosticsOmitted + "." + (snapshot.coverage.reasons.length ? " Limitations: " + snapshot.coverage.reasons.join(", ") + "." : "") + (snapshot.coverage.diagnosticsOmitted ? " Include nonverified candidate diagnostics for a broader capture; missing launch evidence does not prove exit." : "");
    el("applied").textContent = "Applied capture filters: " + JSON.stringify(snapshot.filters) + ". Edited exact filters apply only on refresh.";
    el("objectives-observed").textContent = "Recorded objective metadata read: " + objectiveMetadata.capture.startedAt + " to " + objectiveMetadata.capture.endedAt + ". Screened previews are separate from process verification; raw objectives are never displayed.";
    el("location-all").textContent = "All locations (" + snapshot.rows.length + ")";
    for (const state of Object.keys(locationNames)) el("location-" + state).textContent = locationNames[state] + " (" + snapshot.rows.filter(row => row.herdr.state === state).length + ")";
  }
  async function refresh(event) {
    if (event) event.preventDefault(); if (busy) return;
    failureHint = "Check the local server, then retry Refresh capture.";
    busy = true; showStatus(); controls.forEach(control => { control.disabled = true; });
    const params = new URLSearchParams();
    for (const key of ["deployment", "ticket", "repo"]) if (el(key).value.trim()) params.set(key, el(key).value.trim());
    params.set("all", String(el("all").checked));
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 16000);
    try {
      const reply = await fetch("/v1/dashboard?" + params, { method: "GET", headers: { "X-PPA-Sessions": "1" }, cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
      if (!reply.ok) {
        if (reply.status === 400) failureHint = "Check the exact deployment, ticket and repository-key filters, then retry Refresh capture. Paths and duplicate filters are not supported.";
        else if (reply.status === 503) failureHint = "The collector is busy or local evidence is unavailable. Wait for the in-flight capture, then retry; ask the runtime maintainer if this persists.";
        throw new Error("unavailable");
      }
      const dashboard = await reply.json();
      if (dashboard.schemaVersion !== "ppa-session-dashboard/v1" || !dashboard.objectives?.capture || !Number.isFinite(Date.parse(dashboard.objectives.capture.endedAt)) || !dashboard.objectives.byDeployment || typeof dashboard.objectives.byDeployment !== "object" || Array.isArray(dashboard.objectives.byDeployment)) throw new Error("invalid dashboard capture");
      const next = dashboard.inventory;
      if (!next || next.schemaVersion !== "ppa-sessions/v1" || !Array.isArray(next.rows) || !Number.isFinite(Date.parse(next.capture?.endedAt)) || !Array.isArray(next.coverage?.reasons) || !next.filters) throw new Error("invalid capture");
      const nextView = buildView(next);
      snapshot = next; objectiveMetadata = dashboard.objectives; view = nextView; page = 0; failed = false; updateCaptureMetadata(); render();
    } catch { failed = true; }
    finally { clearTimeout(timer); busy = false; controls.forEach(control => { control.disabled = false; }); showStatus(); }
  }
  form.addEventListener("submit", refresh);
  const filterView = () => { if (snapshot) { page = 0; view = buildView(snapshot); render(); } };
  el("search").addEventListener("input", filterView); el("location").addEventListener("change", filterView);
  el("previous").addEventListener("click", () => { page--; render(); }); el("next").addEventListener("click", () => { page++; render(); });
  setInterval(showStatus, 1000); // Age labels only; never poll for data.
  refresh();
})();`;
