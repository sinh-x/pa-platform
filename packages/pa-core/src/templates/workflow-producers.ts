import { assertProducerTuple, parsePairSignoff, parseTaskHandoff, producerHeader, producerPreamble, type TaskHandoff } from "../tickets/producer-contract.js";
import { reject, type Row, type TemplateEntry } from "./schema.js";

export function validateWorkflowProducer(candidate: string, entry: TemplateEntry, bindings: Row): void {
  const handoffType = bindings.handoffType as TaskHandoff["handoffType"];
  const expected: TaskHandoff = { ticket: bindings.ticket as string, repositoryKey: bindings.repositoryKey as string, repositoryRoot: bindings.repositoryRoot as string,
    handoffType, branch: bindings.branch as string, baseSha: bindings.baseSha as string, branchAction: handoffType === "fresh" ? "create" : "reuse", linkedBranchState: handoffType === "fresh" ? "planned" : "materialized",
    ...(Object.hasOwn(bindings, "featureSha") ? { featureSha: bindings.featureSha as string } : {}) };
  if (entry.id === "pair-signoff") {
    const parsed = parsePairSignoff(candidate); assertProducerTuple(parsed, expected);
    for (const key of ["reviewRevision", "requirementsSource", "requirementsPreviewPath", "requirementsPreviewSha256", "uatPreviewPath", "uatPreviewSha256", "matrixSource", "matrixSha256"] as const) {
      if (parsed[key] !== bindings[key]) reject("TEMPLATE_BINDING", "producer", "complete source-bound sign-off differs from the exact typed bindings");
    }
  } else {
    const parsed = parseTaskHandoff(candidate); assertProducerTuple(parsed, expected);
    if (entry.id !== `handoff-${parsed.handoffType}` || producerHeader(producerPreamble(candidate), "Status") !== "Draft") reject("TEMPLATE_BINDING", "producer", "handoff must be the exact declared kind and remain a draft");
  }
}
