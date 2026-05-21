import { Hono } from "hono";
import { listKnowledgeBoundaries, listImprovementCandidates } from "../../knowledge/index.js";
import { computeDeploymentStatuses, readRegistry } from "../../registry/index.js";
import { buildSkillRegistryReport } from "../../skills/index.js";
import { TicketStore } from "../../tickets/store.js";

const DEPLOYMENT_LIMIT = 200;
const TICKET_LIMIT = 500;
const SKILL_LIMIT = 250;
const IMPROVEMENT_LIMIT = 500;

export function dashboardRoutes(store = new TicketStore()): Hono {
  const app = new Hono();

  app.get("/api/dashboard/overview", (c) => {
    const deployments = computeDeploymentStatuses(readRegistry()).slice(0, DEPLOYMENT_LIMIT);
    const tickets = store.list().slice(0, TICKET_LIMIT);
    const skills = buildSkillRegistryReport().inventory.slice(0, SKILL_LIMIT);
    const boundaries = listKnowledgeBoundaries();
    const candidates = listImprovementCandidates().slice(0, IMPROVEMENT_LIMIT);
    return c.json({
      readOnly: true,
      mutationRoutes: [],
      limits: {
        deployments: DEPLOYMENT_LIMIT,
        tickets: TICKET_LIMIT,
        skills: SKILL_LIMIT,
        improvementCandidates: IMPROVEMENT_LIMIT,
      },
      counts: {
        deployments: deployments.length,
        tickets: tickets.length,
        skills: skills.length,
        knowledgeAreas: boundaries.length,
        improvementCandidates: candidates.length,
      },
    });
  });

  app.get("/api/dashboard/views/deployments", (c) => {
    const deployments = computeDeploymentStatuses(readRegistry()).slice(0, DEPLOYMENT_LIMIT);
    return c.json({ deployments, count: deployments.length, readOnly: true });
  });

  app.get("/api/dashboard/views/tickets", (c) => {
    const tickets = store.list().slice(0, TICKET_LIMIT);
    return c.json({ tickets, count: tickets.length, readOnly: true });
  });

  app.get("/api/dashboard/views/skills", (c) => {
    const report = buildSkillRegistryReport();
    return c.json({
      generatedAt: report.generatedAt,
      scannedRoots: report.scannedRoots,
      inventory: report.inventory.slice(0, SKILL_LIMIT),
      count: Math.min(report.inventory.length, SKILL_LIMIT),
      readOnly: true,
    });
  });

  app.get("/api/dashboard/views/knowledge-memory", (c) => {
    const boundaries = listKnowledgeBoundaries();
    return c.json({ boundaries, count: boundaries.length, readOnly: true });
  });

  app.get("/api/dashboard/views/improvement-candidates", (c) => {
    const candidates = listImprovementCandidates().slice(0, IMPROVEMENT_LIMIT);
    return c.json({ candidates, count: candidates.length, readOnly: true });
  });

  app.get("/dashboard", (c) => c.html(dashboardHtml()));

  return app;
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PA Local Dashboard</title>
  <style>
    :root {
      --bg: #f7f5f1;
      --panel: #fffdf8;
      --ink: #1f2933;
      --muted: #5a6872;
      --accent: #0f766e;
      --line: #d9d3c7;
    }
    body { margin: 0; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; color: var(--ink); background: radial-gradient(circle at 20% 20%, #fff7db, var(--bg)); }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 40px; }
    h1 { margin: 0 0 8px; font-size: 1.6rem; }
    .sub { margin: 0 0 16px; color: var(--muted); }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .card, section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 5px 20px rgba(31, 41, 51, 0.06); }
    .card { padding: 12px; }
    .label { color: var(--muted); font-size: 0.86rem; }
    .value { font-size: 1.4rem; font-weight: 700; color: var(--accent); }
    section { margin-top: 14px; padding: 12px; }
    h2 { margin: 0 0 10px; font-size: 1rem; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 4px 0; }
    .empty { color: var(--muted); font-style: italic; }
    .pill { display: inline-block; margin-top: 10px; border: 1px solid #b8d4d0; background: #edf8f6; color: #0b5f58; border-radius: 999px; padding: 5px 10px; font-size: 0.8rem; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>PA Local Dashboard (Phase 1)</h1>
    <p class="sub">Read-only operational view backed by local PA state.</p>
    <div id="cards" class="cards"></div>
    <section><h2>Deployments</h2><div id="deployments"></div></section>
    <section><h2>Tickets</h2><div id="tickets"></div></section>
    <section><h2>Skills</h2><div id="skills"></div></section>
    <section><h2>Knowledge and Memory Areas</h2><div id="knowledge"></div></section>
    <section><h2>Improvement Candidates</h2><div id="improvements"></div></section>
    <div class="pill">Phase 1 is read-only: no ticket, registry, doc-ref, bulletin, or secret mutations.</div>
  </main>
  <script>
    const read = async (url) => (await fetch(url)).json();
    const list = (items, render) => items.length
      ? '<ul>' + items.map((item) => '<li>' + render(item) + '</li>').join('') + '</ul>'
      : '<div class="empty">No records yet.</div>';
    Promise.all([
      read('/api/dashboard/overview'),
      read('/api/dashboard/views/deployments'),
      read('/api/dashboard/views/tickets'),
      read('/api/dashboard/views/skills'),
      read('/api/dashboard/views/knowledge-memory'),
      read('/api/dashboard/views/improvement-candidates')
    ]).then(([overview, deployments, tickets, skills, knowledge, improvements]) => {
      document.getElementById('cards').innerHTML = [
        ['Deployments', overview.counts.deployments],
        ['Tickets', overview.counts.tickets],
        ['Skills', overview.counts.skills],
        ['Knowledge Areas', overview.counts.knowledgeAreas],
        ['Improvement Candidates', overview.counts.improvementCandidates]
      ].map(([label, value]) => '<div class="card"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>').join('');
      document.getElementById('deployments').innerHTML = list(deployments.deployments, (d) => d.deploy_id + ' - ' + d.status);
      document.getElementById('tickets').innerHTML = list(tickets.tickets, (t) => t.id + ' - ' + t.title);
      document.getElementById('skills').innerHTML = list(skills.inventory, (s) => s.name + ' (' + s.validationStatus + ')');
      document.getElementById('knowledge').innerHTML = list(knowledge.boundaries, (b) => b.itemType + ': ' + b.storageLocation);
      document.getElementById('improvements').innerHTML = list(improvements.candidates, (c) => c.summary + ' [' + c.sourceType + ']');
    }).catch((error) => {
      document.getElementById('cards').innerHTML = '<div class="card"><div class="label">Error</div><div>' + String(error) + '</div></div>';
    });
  </script>
</body>
</html>`;
}
