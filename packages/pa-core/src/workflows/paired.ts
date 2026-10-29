import type { TemplateSelection } from "../templates/registry.js";
import { array, digest, ID, literal, object, relativePath, reject, SHA256, strictJson, text, unique } from "./contracts.js";
import { readWorkflowEvidence } from "./evidence.js";
import { produceWorkflowSubject } from "./producer.js";
import type { WorkflowSelection } from "./selected.js";

/** Selected PAPC fixture bytes, not a new registry, decision issuer, result importer or readiness flag. */
export function validateWorkflowPair(selection: WorkflowSelection, templates: TemplateSelection, rawFixtures: Uint8Array, read: (relative: string) => Uint8Array) {
  if (selection.configRoot !== templates.root || selection.configRevision !== templates.configRevision) reject("WORKFLOW_SOURCE");
  const root = object(strictJson(rawFixtures), ["schemaVersion", "fixtures"]); literal(root.schemaVersion, "pa-workflow-fixtures/v1");
  const cases = array(root.fixtures, value => {
    const r = object(value, ["id", "team", "mode", "producer", "requirementsFile", "uatFile", "candidateSha256"]);
    const id = text(r.id, ID), team = text(r.team, ID), mode = text(r.mode, ID);
    if (typeof r.producer !== "string" || !r.producer.length || Buffer.byteLength(r.producer) > 65_536) reject();
    const producer = r.producer;
    const produced = produceWorkflowSubject(selection, Buffer.from(producer), { selection: templates, team, mode });
    // Structural validation must also work while PAPC keeps bindings disabled.
    // This is deliberately NOT new-run selection/admission or an enablement override.
    const binding = selection.bindings.find(b => b.team === team && b.mode === mode);
    const selected = binding && selection.definitions.find(d => d.definition.workflowId === binding.workflowId && d.definition.version === binding.workflowVersion);
    if (!binding || !selected) reject("WORKFLOW_SOURCE");
    const subject = produced.subject;
    if (digest(produced.raw) !== text(r.candidateSha256, SHA256) || subject.workflow.sha256 !== selected.sha256 || subject.workflow.id !== selected.definition.workflowId || subject.workflow.version !== selected.definition.version) reject("WORKFLOW_SOURCE");
    const paths = [relativePath(r.requirementsFile), relativePath(r.uatFile)];
    if (paths.some(p => !p.startsWith("workflows/fixtures/"))) reject("WORKFLOW_SOURCE");
    const [requirements, uat] = paths.map(path => read(path));
    readWorkflowEvidence(subject, ref => ref.ref === subject.requirements.ref ? requirements! : ref.ref === subject.uat.ref ? uat! : null);
    return { id, team, mode, bindingEnabled: binding.enabled, handoff: subject.handoff.type, definitionSha256: selected.sha256, candidateSha256: digest(produced.raw) };
  });
  unique(cases.map(c => c.id));
  for (const binding of selection.bindings) {
    const fixtures = cases.filter(c => c.team === binding.team && c.mode === binding.mode);
    if (!["fresh", "amendment"].every(type => fixtures.some(f => f.handoff === type))) reject("WORKFLOW_SOURCE");
  }
  return { schemaVersion: "pa-workflow-pair-validation/v1", structuralOnly: true, authority: false, executionAdmitted: false, fixtures: cases };
}
