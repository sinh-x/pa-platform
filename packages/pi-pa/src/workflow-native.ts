import { randomUUID, createHash } from "node:crypto";
import { userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { queryDeploymentStatus, getDeploymentEvents, JsonWorkflowError, MAX_WORKFLOW_RECORD_BYTES, type WorkflowCaller, type WorkflowHost } from "@pa-platform/pa-core";
import { authenticatePiPreparationCaller, type PiPreparationContext } from "./pi-extension/prepared-workflow.js";

export interface PiWorkflowContext extends PiPreparationContext {
  readonly ui?: { select(title: string, choices: string[], options?: { signal?: AbortSignal }): Promise<string | undefined> };
}
export function authenticatePiWorkflowCaller(context: PiWorkflowContext, env: NodeJS.ProcessEnv = process.env): WorkflowCaller {
  // Reuse existing registry/process-incarnation/canonical-root/foreground authentication, not environment identity alone.
  const caller = authenticatePiPreparationCaller(context, env);
  return { deploymentId: caller.deploymentId, repoKey: caller.repoKey, repoRoot: caller.repoRoot, ticket: caller.ticket,
    team: "requirements", mode: "analyze", identitySha256: caller.callerIdentity };
}
/** Current caller is authenticated by the existing foreground/process owner, never supplied by JSON.
 * Only immutable registry resume edges of the SAME role/repository/ticket can continue an admitted run. */
export function createPiWorkflowContinuation(authenticate: () => WorkflowCaller): NonNullable<WorkflowHost["continues"]> {
  return (original, current) => {
    if (!isDeepStrictEqual(authenticate(), current) || original.repoKey !== current.repoKey || original.repoRoot !== current.repoRoot || original.ticket !== current.ticket
      || original.team !== current.team || original.mode !== current.mode) return false;
    let id = current.deploymentId; const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (seen.has(id)) return false; seen.add(id);
      const status = queryDeploymentStatus(id), starts = getDeploymentEvents(id).filter(e => e.event === "started"), start = starts[0];
      if (!status || starts.length !== 1 || !start || start.runtime !== "pi" || start.binary !== "ppa" || start.team !== original.team || start.mode !== original.mode
        || start.repo_root !== original.repoRoot || start.repo !== original.repoRoot || start.worktree_root !== original.repoRoot || start.ticket_id !== original.ticket || start.builder_authority || start.rogue_one
        || status.runtime !== "pi" || status.team !== original.team || status.mode !== original.mode
        || status.repo_root !== original.repoRoot || status.ticket_id !== original.ticket || status.rogue_one
        || (depth === 0 ? status.status !== "running" : status.status === "running")) return false;
      if (id === original.deploymentId) return true;
      const predecessor = starts[0]!.resumed_from_deployment_id;
      if (!predecessor || predecessor !== status.resumed_from_deployment_id) return false;
      id = predecessor;
    }
    return false;
  };
}
const CHOICES = ["Approve exact package and displayed permissions", "Reject exact package", "Request changes", "Cancel"];
const TECHNICAL = "View exact technical bindings";
const visible = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
function pages(lines: string[]): string[] {
  const wrapped = lines.flatMap(line => {
    const text = visible(line); return text.match(/.{1,72}/gu) ?? [""];
  });
  const result: string[] = [];
  for (let index = 0; index < wrapped.length; index += 9) result.push(wrapped.slice(index, index + 9).join("\n"));
  return result;
}
/** Native-only port. All finite scope is reviewed in short ordinary-language
 * pages before the decision. Exact JSON is optional technical detail, never the
 * primary question. Capture evidence binds both source bytes and presentation.
 */
export function createPiWorkflowCapture(context: PiWorkflowContext, authenticate: () => WorkflowCaller = () => authenticatePiWorkflowCaller(context)): WorkflowHost["capture"] {
  return async request => {
    if (context.mode !== "tui" || !context.ui?.select) throw new JsonWorkflowError("WORKFLOW_AUTHORITY", "native-foreground", "operator");
    const before = authenticate(), subject = request.subject;
    const recovering = request.action !== "revoke" && Boolean(request.decisionId);
    const raw = JSON.stringify(request, null, 2);
    if (Buffer.byteLength(raw, "utf8") > MAX_WORKFLOW_RECORD_BYTES) throw new JsonWorkflowError("WORKFLOW_CONTRACT", "decision-request-size", "package-owner");
    const list = (title: string, values: readonly string[]) => [title, ...(values.length ? values.map(value => `- ${value}`) : ["- none"])];
    const review = pages([
      `${subject.ticket}: review the exact implementation plan`,
      recovering ? `Resume cancelled review ${request.decisionId}. Previous cancellation stays in history; only your fresh decision can grant permissions.`
        : request.action === "revoke" ? `Revoke decision ${request.decisionId}; this does not undo completed effects.` : "Approve, reject, request changes, or cancel this exact package.",
      "Approval is not a claim that tests or human UAT passed.",
      `Repository: ${subject.repository.key} (${subject.repository.root})`,
      `Route: ${subject.route.team}/${subject.route.mode}`,
      `Branch: ${subject.handoff.branch} (${subject.handoff.branchAction})`,
      `Base: ${subject.handoff.baseSha}`,
      ...(subject.handoff.type === "amendment" ? [`Feature: ${subject.handoff.featureSha}`] : []),
      ...(["requirements", "uat", "matrix"] as const).flatMap(kind => [`${kind}: ${subject[kind].version}`, subject[kind].ref, `SHA256: ${subject[kind].sha256}`]),
      ...list("Requirements", subject.scope.requirements), ...list("Acceptance criteria", subject.scope.acceptanceCriteria),
      ...list("Files", subject.scope.files), ...list("Directories", subject.scope.directories), ...list("New paths", subject.scope.newPaths),
      ...list("Checks (exact matrix-bound command IDs)", subject.scope.checks.map(check => `${check.commandId}; ${check.matrixSource}; SHA256 ${check.matrixSha256}`)),
      ...list("Requested permissions", subject.requestedPermissions), ...list("Excluded effects", subject.scope.excludedEffects),
      `Run: ${request.runId}; revision: ${request.revision}`, `Subject: ${subject.subjectId}; revision: ${subject.revision}`, `Subject SHA256: ${request.subjectSha256}`,
      `Workflow: ${subject.workflow.id}/${subject.workflow.version}; SHA256 ${subject.workflow.sha256}`,
      ...(request.resources ? [`Pinned config: ${request.resources.configRevision}`, `Registry SHA256: ${request.resources.registrySha256}`] : []),
    ]);
    const technical = pages(raw.split("\n")), transcript: { title: string; selected: string | null }[] = [];
    const select = async (title: string, choices: string[]) => {
      const selected = await context.ui!.select(title, choices);
      transcript.push({ title, selected: choices.includes(selected ?? "") ? selected! : null }); return selected;
    };
    const readPages = async (label: string, content: string[]) => {
      for (let index = 0; index < content.length; index++) if (await select(`${label} ${index + 1}/${content.length}\n${content[index]}`, ["Continue review", "Cancel"]) !== "Continue review") return false;
      return true;
    };
    let selected: string | undefined;
    if (await readPages(recovering ? "Resume cancelled package review" : "Exact package review", review)) {
      const choices = request.action === "revoke" ? ["Revoke this exact decision", "Cancel", TECHNICAL] : [...CHOICES, TECHNICAL];
      for (let attempt = 0; attempt < 16; attempt++) {
        selected = await select(`${visible(subject.ticket)}: ${request.action === "revoke" ? "revoke the named decision?" : "approve the reviewed plan and its finite permissions?"}\nNo scope beyond the reviewed pages is granted.\nSubject SHA256:\n${request.subjectSha256}`, choices);
        if (selected !== TECHNICAL) break;
        selected = undefined;
        if (!await readPages("Technical bindings", technical)) break;
      }
    }
    const after = authenticate();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new JsonWorkflowError("WORKFLOW_CONFLICT", "stale-native-caller", "launcher-owner");
    const outcome = request.action === "revoke" ? selected === "Revoke this exact decision" ? "approved" : "cancelled"
      : selected === CHOICES[0] ? "approved" : selected === CHOICES[1] ? "rejected" : selected === CHOICES[2] ? "changes-requested" : "cancelled";
    const captureId = randomUUID();
    const sha256 = createHash("sha256").update(JSON.stringify({ schemaVersion: "pa-native-review/v2", captureId, caller: before.identitySha256, raw, review, transcript, outcome })).digest("hex");
    return { outcome, principal: `local-uid:${userInfo().uid}`, evidence: { schemaVersion: "pa-workflow-evidence-ref/v1", ref: `native-workflow-capture:${captureId}`, version: "v2", sha256 } };
  };
}
