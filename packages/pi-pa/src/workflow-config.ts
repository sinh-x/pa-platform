import { lstatSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertRetainedConfigIdentity, getTicketsDir, JsonWorkflowError, materializeWorkflowResources, readTicketWorkflow, retainedWorkflowTeam, withExistingWorkflowJournal, type DeployRequest } from "@pa-platform/pa-core";

/** Read-only lookup before planning. No environment/run/hash import or authority
 * upgrade: the ticket and immutable registry own the exact retained subject. */
export function pinnedPiWorkflowConfig(request: DeployRequest) {
  if (!request.ticket || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(request.ticket) || request.ticket.length > 64 || !["requirements", "builder"].includes(request.team)) return null;
  try { lstatSync(join(getTicketsDir(), `${request.ticket}.json`)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const state = readTicketWorkflow(request.ticket); if (!state) return null;
  const blocked = (): never => { throw new JsonWorkflowError("WORKFLOW_SOURCE", "retained-resource-closure", "config-runtime-owner"); };
  assertRetainedConfigIdentity(state);
  const mode = request.mode ?? (request.team === state.caller.team ? state.caller.mode : state.subject.route.mode);
  const team = withExistingWorkflowJournal(journal => journal ? retainedWorkflowTeam(journal, state, request.team, mode) : blocked());
  if (request.mode === undefined && team.default_mode !== undefined && team.default_mode !== mode) blocked();
  const reread = () => {
    const fresh = readTicketWorkflow(request.ticket!);
    if (!fresh || fresh.runId !== state.runId || fresh.subjectSha256 !== state.subjectSha256 || !isDeepStrictEqual(fresh.resources, state.resources)) return blocked();
    assertRetainedConfigIdentity(fresh); return fresh;
  };
  return { state, team, reread, materialize: (directory: string) => withExistingWorkflowJournal(journal => journal ? materializeWorkflowResources(journal, reread(), directory) : blocked()) };
}
