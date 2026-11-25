import { formatBoundedFiveFieldDiagnostic, isCanonicalTicketId, type CliIo } from "@pa-platform/pa-core";
import { captureSessions, type SessionSnapshot } from "./session-capture.js";
import { sessionDisplayText, type SessionFilters } from "./session-inventory.js";

export const SESSIONS_USAGE = `Usage: ppa sessions [--all] [--json] [--deployment ID] [--ticket ID] [--repo KEY]

List verified-open local Linux PPA/Pi processes, grouped by HerdR session/workspace/tab.
Open means alive, not actively working or completed. Registry status is independent.
Each call reads fresh evidence. Locations describe an observation window, not a lock.

Options:
  --all              Include exited, mismatched and unverified candidate diagnostics
  --json             Emit one ppa-sessions/v1 JSON document
  --deployment ID    Exact deployment ID (d- plus six lowercase hex digits)
  --ticket ID        Exact current ticket ID
  --repo KEY         Exact canonical registered repository key (not a path)
  --help, -h         Show this help without collection

Filters intersect. Non-HerdR processes remain visible; qualified locations mean
observed with HerdR coverage incomplete, not a unique location claim.
Existing launch evidence is required; missing records are never backfilled.
Budgets: 10,000 candidates, 64 HerdR sessions, 1,024 panes; nominal 10-second window.
HerdR protocol 22 only. Bounds, unavailable sources and diagnostics are explicit.
No terminal content, arguments, environment, objectives or socket paths are output.
No session control, lifecycle repair or registry writes are performed.`;
interface Options extends SessionFilters { all: boolean; json: boolean }
export function parseSessionsArgs(args: string[]): Options | "help" | null {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return "help";
  const options: Options = { all: false, json: false }, seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!; if (seen.has(arg)) return null; seen.add(arg);
    if (arg === "--all") options.all = true;
    else if (arg === "--json") options.json = true;
    else if (["--deployment", "--ticket", "--repo"].includes(arg)) {
      const value = args[++i]; if (!value || value.length > 128 || sessionDisplayText(value) !== value) return null;
      if (arg === "--deployment" && /^d-[a-f0-9]{6}$/.test(value)) options.deployment = value;
      else if (arg === "--ticket" && isCanonicalTicketId(value)) options.ticket = value;
      else if (arg === "--repo" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) options.repo = value;
      else return null;
    } else return null;
  }
  return options;
}
export function sessionsFailure(kind: "usage" | "registry"): string {
  return `${kind === "usage" ? "Session inventory not started: invalid options." : "Session inventory unavailable: local evidence could not be read."}\n` + formatBoundedFiveFieldDiagnostic({
    condition: kind === "usage" ? "The requested inventory was not collected" : "No inventory rows can be established for this capture",
    source: kind === "usage" ? "PPA sessions argument check" : "Existing local registry and inventory reader",
    reason: kind === "usage" ? "An option is unsupported, duplicated or missing a valid exact value" : "Required local metadata is missing, inaccessible, unstable or invalid; the precise infrastructure cause is unverified",
    correction: kind === "usage" ? "Read ppa sessions --help and correct the options. Impact: read-only. Actor: agent or operator. New approval: not required. Prerequisite: supported PPA CLI"
      : "Ask the PA runtime maintainer to inspect the existing local registry and runtime. Impact: none to ask. Actor: operator. New approval: not required to ask; repairs need their own authority. Prerequisite: retain existing evidence",
    resumeAction: kind === "usage" ? "After correcting options, repeat the read-only inventory request" : "Repeat the read-only inventory after the owning maintainer establishes readable local evidence; do not reset or reconcile records with this command",
  });
}
/** Pure table over precisely the same public rows and capture metadata as JSON. */
export function formatSessions(snapshot: SessionSnapshot): string {
  const lines = [`Local PPA/Pi session inventory: ${snapshot.rows.length} ${snapshot.filters.all ? "candidate(s)" : "verified-open process(es)"}.`,
    `Capture: ${snapshot.capture.startedAt} to ${snapshot.capture.endedAt}`,
    "Open means alive, not actively working or completed. Registry status is separate.",
    `Scope: ${snapshot.scope}; filters: ${JSON.stringify(snapshot.filters)}`,
    `Coverage: ${snapshot.coverage.complete ? "complete within scope" : "incomplete"}; candidates observed: ${snapshot.coverage.candidatesObserved}; diagnostics omitted: ${snapshot.coverage.diagnosticsOmitted}.`];
  if (snapshot.coverage.reasons.length) lines.push(`Limitations: ${snapshot.coverage.reasons.join(", ")}.`, "Refresh with ppa sessions to recheck; independently verified processes remain visible.");
  if (snapshot.coverage.diagnosticsOmitted) lines.push("Use ppa sessions --all to inspect omitted candidates; missing launch evidence is unverified, not proven exit.");
  if (snapshot.rows.length === 0) lines.push("No matching sessions are shown in this view. No action is required; remove filters or use --all for a broader view.");
  const groups = new Map<string, SessionSnapshot["rows"]>();
  for (const row of snapshot.rows) {
    const mapping = row.herdr;
    const group = "location" in mapping ? `HerdR session ${mapping.location.session} / workspace ${mapping.location.workspaceLabel ?? "(unlabelled)"} [${mapping.location.workspaceId}] / tab ${mapping.location.tabLabel ?? "(unlabelled)"} [${mapping.location.tabId}]`
      : `No verified HerdR location (${mapping.state})`;
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  for (const [group, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("", group, "DEPLOYMENT | TICKET | TEAM/MODE | REPOSITORY | STARTED | REGISTRY | PROCESS | PID | PANE | LOCATION");
    for (const row of rows) {
      const open = row.process.state === "verified-open", mapping = row.herdr;
      lines.push([row.deploymentId, row.ticket ?? "-", `${row.team ?? "-"}/${row.mode ?? "-"}`, row.repository ?? "unknown", row.startedAt ?? "unknown", row.registryStatus ?? "unknown",
        open ? "verified-open" : `${row.process.state}: ${"reason" in row.process ? row.process.reason : "unknown"}`,
        row.process.state === "verified-open" ? String(row.process.pid) : `candidate:${row.candidatePid ?? "unknown"}`,
        "location" in mapping ? mapping.location.paneId : "-",
        mapping.state === "qualified" ? "observed with HerdR coverage incomplete" : "reason" in mapping ? `${mapping.state}: ${mapping.reason}` : mapping.state].join(" | "));
    }
  }
  return lines.join("\n");
}
export async function runSessionsCommand(args: string[], io: Required<CliIo>, capture: typeof captureSessions = captureSessions): Promise<number> {
  const options = parseSessionsArgs(args);
  if (options === "help") { io.stdout(SESSIONS_USAGE); return 0; }
  if (!options) { io.stderr(sessionsFailure("usage")); return 1; }
  try {
    const { json, ...filters } = options;
    const snapshot = await capture(filters);
    io.stdout(json ? JSON.stringify(snapshot) : formatSessions(snapshot)); return 0;
  } catch { io.stderr(sessionsFailure("registry")); return 1; }
}
