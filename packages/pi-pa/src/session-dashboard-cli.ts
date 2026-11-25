import { formatBoundedFiveFieldDiagnostic, type CliIo } from "@pa-platform/pa-core";
import { startSessionDashboard } from "./session-dashboard-server.js";

export const DASHBOARD_USAGE = `Usage: ppa sessions dashboard --port PORT

Start a dedicated read-only local PPA/Pi session dashboard in the foreground.
  --port PORT   Required numeric port from 1 through 65535 on 127.0.0.1 only
  --help, -h    Show help without listening or collecting

Open the printed local address yourself; no browser is launched.
Initial page load captures once; Refresh capture manually reads fresh evidence.
Exact deployment/ticket/repository filters, candidate diagnostics and grouping
are available in the page. Open means alive, not actively working.
The page labels incomplete coverage and captures at least 60 seconds old as stale.
Local OS processes are trusted: no separate user authentication. Browser Host,
origin and custom-header checks are not protection from other local programs.
Do not proxy, publish or forward this port, or use it on an untrusted shared host.
No session controls, terminal content, lifecycle reconciliation or registry writes.
Press Ctrl-C to close only this dashboard server, not displayed sessions.`;

export function parseDashboardArgs(args: string[]): number | "help" | null {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return "help";
  if (args.length !== 2 || args[0] !== "--port" || !/^[1-9][0-9]{0,4}$/.test(args[1]!)) return null;
  const port = Number(args[1]); return port <= 65535 ? port : null;
}
export function dashboardFailure(kind: "usage" | "listen"): string {
  return (kind === "usage" ? "Session dashboard not started: invalid options.\n" : "Session dashboard unavailable: its local listener could not be established or retained.\n") + formatBoundedFiveFieldDiagnostic({
    condition: kind === "usage" ? "No dashboard listener or inventory collection was started" : "This dashboard cannot serve observations; displayed sessions are not controlled",
    source: kind === "usage" ? "PPA dashboard argument check" : "Dedicated numeric-loopback dashboard listener",
    reason: kind === "usage" ? "Exactly one valid --port value is required; other options are unsupported" : "The selected port may be occupied or inaccessible; the precise infrastructure cause is unverified",
    correction: kind === "usage" ? "Read ppa sessions dashboard --help and select a valid explicit port. Impact: read-only. Actor: agent or operator. New approval: not required for help. Prerequisite: supported PPA CLI"
      : "Ask the runtime maintainer to inspect availability of the selected local port. Impact: none to ask. Actor: operator. New approval: not required to ask; repairs need their own authority. Prerequisite: preserve existing listeners; do not stop unrelated services",
    resumeAction: kind === "usage" ? "After correcting the options, repeat the explicit dashboard start request; it opens a local listener, never displayed sessions"
      : "Start this dashboard again only after a usable local port is established; no registry reconciliation or session restart is needed",
  });
}
/** Resource start is separate from the pure inventory route. Signal handlers close
 * only this listener and are removed when it closes; no process/session controls. */
export async function runSessionDashboardCommand(args: string[], io: Required<CliIo>, start: typeof startSessionDashboard = startSessionDashboard): Promise<number> {
  const port = parseDashboardArgs(args);
  if (port === "help") { io.stdout(DASHBOARD_USAGE); return 0; }
  if (port === null) { io.stderr(dashboardFailure("usage")); return 1; }
  try {
    const server = await start({ port });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("unavailable"); }
    const stop = () => { server.closeAllConnections(); server.close(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    server.once("close", () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); });
    server.on("error", () => { io.stderr(dashboardFailure("listen")); process.exitCode = 1; stop(); });
    io.stdout(`Local session dashboard listening at http://127.0.0.1:${address.port}/\nOpen this address manually. Refresh captures read-only observations; open is not actively working.\nLocal processes are trusted; there is no separate user authentication. Do not forward or publish this port.\nPress Ctrl-C to close only this dashboard server. No displayed session is controlled.`);
    return 0;
  } catch { io.stderr(dashboardFailure("listen")); return 1; }
}
