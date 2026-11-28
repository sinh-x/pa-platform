// Runs only in an expendable child process: synchronous native I/O cannot stall
// Pi's editor. No registry initialization, ticket constructors or write owners.
import { loadReposYaml, queryReadonlyDeploymentEvents, queryReadonlyDeploymentStatus, TicketStore } from "@pa-platform/pa-core";
import { contextText } from "./context-text.js";

try {
  const request = JSON.parse(process.argv[2]!) as { kind: string; deploymentId: string; cwd: string; project?: string; ticket?: string };
  const observe = () => {
    const row = queryReadonlyDeploymentStatus(request.deploymentId, true);
    const start = queryReadonlyDeploymentEvents(request.deploymentId, true).find(event => event.event === "started");
    if (!row || !start || row.deploy_id !== request.deploymentId || !start.repo_root || row.repo_root !== start.repo_root
      || (start.worktree_root ?? start.repo) !== request.cwd || (row.worktree_root ?? row.repo) !== request.cwd) throw new Error();
    const matches = Object.entries(loadReposYaml()).filter(([, repo]) => repo.path === start.repo_root);
    if (matches.length !== 1) throw new Error();
    return { row, start, project: matches[0]![0] };
  };
  const { row, start, project } = observe();
  if (request.kind === "deployment") {
    process.stdout.write(JSON.stringify({ status: row.status, ticket: row.ticket_id || undefined, project,
      objective: typeof start.objective === "string" ? contextText(start.objective) : undefined }));
  } else if (request.kind === "ticket" && request.project === project && request.ticket && request.ticket === row.ticket_id) {
    const ticket = TicketStore.readSummary(project, request.ticket);
    const after = observe();
    if (!ticket || after.row.ticket_id !== request.ticket || after.project !== project) throw new Error();
    process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(ticket).map(([key, value]) => [key, contextText(value)]))));
  } else throw new Error();
} catch {
  // Never expose raw native diagnostics, record bodies or foreign identities.
  process.stdout.write("null");
}
