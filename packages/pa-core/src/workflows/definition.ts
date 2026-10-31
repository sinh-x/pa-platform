import { array, ID, integer, literal, MAX_WORKFLOW_STEPS, object, oneOf, PACKAGE_PERMISSIONS, reject, STEP_OUTCOMES, strictJson, text, unique, WORKFLOW_CONTRACT, type InputReference, type OutputDeclaration, type Predicate, type WorkflowDefinition, type WorkflowStep } from "./contracts.js";
import { CONTEXT_FIELDS, operationContract, PREDICATE_FIELDS } from "./operations.js";

function predicate(value: unknown, depth = 0): Predicate {
  if (value === true) return true;
  if (depth > 8) reject();
  const r = value as Record<string, unknown>;
  if (r?.op === "eq") { object(r, ["op", "field", "value"]); return { op: "eq", field: oneOf(r.field, PREDICATE_FIELDS), value: text(r.value) }; }
  if (r?.op === "in") {
    object(r, ["op", "field", "values"]); const values = unique(array(r.values, v => text(v), 16)); if (!values.length) reject();
    return { op: "in", field: oneOf(r.field, PREDICATE_FIELDS), values };
  }
  object(r, ["op", "predicates"]); const predicates = array(r.predicates, p => predicate(p, depth + 1), 16); if (!predicates.length) reject();
  return { op: oneOf(r.op, ["all", "any"]), predicates };
}
function output(value: unknown): OutputDeclaration {
  const r = object(value, ["name", "schemaVersion"]); return { name: text(r.name, ID), schemaVersion: text(r.schemaVersion, /^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/) };
}
function input(value: unknown): InputReference {
  const r = value as Record<string, unknown>;
  const context = r?.source === "context";
  object(r, context ? ["name", "schemaVersion", "source", "field"] : ["name", "schemaVersion", "source", "stepId", "output"]);
  const common = output({ name: r.name, schemaVersion: r.schemaVersion });
  return context ? { ...common, source: "context", field: text(r.field) }
    : { ...common, source: literal(r.source, "output"), stepId: text(r.stepId, ID), output: text(r.output, ID) };
}
function step(value: unknown): WorkflowStep {
  const r = object(value, ["id", "order", "title", "kind", "owner", "dependsOn", "when", "inputs", "operation", "authorization", "effects", "outputs", "verification", "transitions", "failurePolicy"], ["description"]);
  const kind = oneOf(r.kind, ["decision", "check", "action", "publication"]);
  const op = object(r.operation, ["id", "version"]);
  const operation = { id: text(op.id, ID), version: literal(op.version, "v1") };
  const contract = operationContract(operation.id, operation.version); if (!contract || contract.kind !== kind || contract.owner !== r.owner) reject();
  const transitions = object(r.transitions, STEP_OUTCOMES[kind]);
  const inputs = array(r.inputs, input); unique(inputs.map(i => i.name));
  const outputs = array(r.outputs, output); unique(outputs.map(o => o.name));
  const authorization = unique(array(r.authorization, p => oneOf(p, PACKAGE_PERMISSIONS)));
  const effects = unique(array(r.effects, e => oneOf(e, contract.effects)));
  // Declarations must exactly describe the operation; omission cannot hide an effect or permission.
  if (authorization.length !== contract.permissions.length || contract.permissions.some(p => !authorization.includes(p))
    || effects.length !== contract.effects.length || inputs.length !== contract.inputSchemas.length
    || contract.inputSchemas.some(s => inputs.filter(i => i.schemaVersion === s).length !== 1)
    || outputs.length !== 1 || outputs[0]?.schemaVersion !== contract.outputSchema) reject();
  const verification = array(r.verification, v => {
    const verifier = object(v, ["id", "version", "inputs"]);
    if (verifier.id !== contract.verifier) reject();
    const names = unique(array(verifier.inputs, n => text(n, ID)));
    if (names.length !== inputs.length || names.some(n => !inputs.some(i => i.name === n))) reject();
    return { id: contract.verifier, version: literal(verifier.version, "v1"), inputs: names };
  });
  if (verification.length !== 1) reject();
  const failure = object(r.failurePolicy, ["strategy", "correctionOwner"]);
  return { id: text(r.id, ID), order: integer(r.order, 1, MAX_WORKFLOW_STEPS), title: text(r.title, undefined, 256),
    ...(r.description === undefined ? {} : { description: text(r.description) }), kind, owner: contract.owner,
    dependsOn: array(r.dependsOn, d => { const dep = object(d, ["stepId", "outcome"]); return { stepId: text(dep.stepId, ID), outcome: oneOf(dep.outcome, Object.values(STEP_OUTCOMES).flat()) }; }),
    when: predicate(r.when), inputs, operation, authorization, effects, outputs, verification,
    transitions: Object.fromEntries(Object.entries(transitions).map(([outcome, target]) => [outcome, text(target, ID)])),
    failurePolicy: { strategy: oneOf(failure.strategy, ["stop", "reconcile", "operator-retry"]), correctionOwner: text(failure.correctionOwner, ID) } };
}
export function parseWorkflowDefinition(bytes: Uint8Array): WorkflowDefinition {
  const r = object(strictJson(bytes), ["schemaVersion", "workflowId", "version", "requiredCapabilities", "steps"]);
  literal(r.schemaVersion, WORKFLOW_CONTRACT);
  const steps = array(r.steps, step, MAX_WORKFLOW_STEPS); if (!steps.length) reject();
  unique(steps.map(s => s.id)); unique(steps.map(s => s.order));
  if (steps.some(s => ["completed", "blocked", "cancelled"].includes(s.id))) reject();
  const byId = new Map(steps.map(s => [s.id, s]));
  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (id: string, visiting = new Set<string>()): Set<string> => {
    if (visiting.has(id)) reject();
    const cached = ancestorCache.get(id); if (cached) return cached;
    const current = byId.get(id); if (!current) reject();
    const next = new Set(visiting).add(id); const found = new Set<string>();
    for (const dep of current.dependsOn) { found.add(dep.stepId); for (const a of ancestors(dep.stepId, next)) found.add(a); }
    ancestorCache.set(id, found);
    return found;
  };
  for (const s of steps) {
    unique(s.dependsOn.map(d => d.stepId));
    const prior = ancestors(s.id);
    for (const d of s.dependsOn) {
      const producer = byId.get(d.stepId); if (!producer || !(STEP_OUTCOMES[producer.kind] as readonly string[]).includes(d.outcome)) reject();
    }
    for (const i of s.inputs) {
      if (i.source === "context") { if (CONTEXT_FIELDS[i.field] !== i.schemaVersion) reject(); }
      else if (!prior.has(i.stepId) || !byId.get(i.stepId)?.outputs.some(o => o.name === i.output && o.schemaVersion === i.schemaVersion)) reject();
    }
    for (const [outcome, target] of Object.entries(s.transitions)) {
      if (["completed", "blocked", "cancelled"].includes(target)) {
        if (outcome === "unknown" && target !== "blocked") reject();
      } else {
        const successor = byId.get(target);
        if (!successor || !successor.dependsOn.some(d => d.stepId === s.id && d.outcome === outcome) || outcome === "unknown") reject();
      }
    }
  }
  const requiredCapabilities = unique(array(r.requiredCapabilities, c => text(c, ID)));
  if (steps.some(s => !requiredCapabilities.includes(operationContract(s.operation.id, "v1")!.capability))) reject();
  return { schemaVersion: WORKFLOW_CONTRACT, workflowId: text(r.workflowId, ID), version: text(r.version, ID), requiredCapabilities, steps };
}
export function evaluatePredicate(predicate: Predicate, context: Readonly<Record<string, string>>): boolean {
  if (predicate === true) return true;
  if (predicate.op === "eq") return context[predicate.field] === predicate.value;
  if (predicate.op === "in") return context[predicate.field] !== undefined && predicate.values.includes(context[predicate.field]!);
  return predicate.op === "all" ? predicate.predicates.every(p => evaluatePredicate(p, context)) : predicate.predicates.some(p => evaluatePredicate(p, context));
}
