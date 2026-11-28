// Fixed plain-JS child program shared by source and compiled hosts. No runtime
// transpiler or shell is involved. The parent supplies its resolved core module.
export const CONTEXT_READ_SCRIPT = String.raw`
const { loadReposYaml, queryReadonlyDeploymentEvents, queryReadonlyDeploymentStatus, readContextTicketSummary } = await import(process.argv[1]);
const text = value => {
  const truncated = value.length > 16384;
  return value.slice(0, 16384).replace(/\r\n?/g, "\n").replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?")
    + (truncated ? "\n[truncated]" : "");
};
try {
  const request = JSON.parse(process.argv[2]);
  const observe = () => {
    const row = queryReadonlyDeploymentStatus(request.deploymentId, true);
    const start = queryReadonlyDeploymentEvents(request.deploymentId, true).find(event => event.event === "started");
    if (!row || !start || row.deploy_id !== request.deploymentId || !start.repo_root || row.repo_root !== start.repo_root
      || (start.worktree_root ?? start.repo) !== request.cwd || (row.worktree_root ?? row.repo) !== request.cwd) throw new Error();
    const matches = Object.entries(loadReposYaml()).filter(([, repo]) => repo.path === start.repo_root);
    if (matches.length !== 1) throw new Error();
    return { row, start, project: matches[0][0] };
  };
  const { row, start, project } = observe();
  if (request.kind === "deployment") {
    process.stdout.write(JSON.stringify({ status: row.status, ticket: row.ticket_id || undefined, project,
      objective: typeof start.objective === "string" ? text(start.objective) : undefined }));
  } else if (request.kind === "ticket" && request.project === project && request.ticket && request.ticket === row.ticket_id) {
    const ticket = readContextTicketSummary(project, request.ticket);
    const after = observe();
    if (!ticket || after.row.ticket_id !== request.ticket || after.project !== project) throw new Error();
    process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(ticket).map(([key, value]) => [key, text(value)]))));
  } else throw new Error();
} catch {
  process.stdout.write("null");
}
`;
