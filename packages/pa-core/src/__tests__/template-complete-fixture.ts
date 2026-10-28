import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest, type Row } from "../templates/schema.js";
import { parseReviewMatrixArtifact, parseReviewObjective } from "../validation/review-contract.js";
import { handoffTemplate, producerFixture } from "./template-producer-fixture.js";

/** One explicitly inventoried disposable selection with positive structural
 * inputs for every entry. No canonical source or real decisions are copied. */
export function completeTemplateFixture() {
  const f = producerFixture("fresh");
  f.put("handoff-amendment", handoffTemplate("amendment"));
  const amendment = { ...f.handoffBindings, handoffType: "amendment", featureSha: f.bindings.baseSha, amendmentSource: "requirements:agent-teams/requirements/artifacts/synthetic-previous.md", tupleApprovalEvidence: "FIX-237#c-19990101000000000", immediateRereadSha256: "d".repeat(64), finalRereadSha256: "e".repeat(64) };
  const objective = parseReviewObjective(readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.objective.json", import.meta.url)));
  const matrix = parseReviewMatrixArtifact(readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url)), objective.matrixSource).matrix;
  const bindings: Record<string, Row> = Object.fromEntries(f.registry.entries.map(e => [e.id, { ticket: "FIX-1" }]));
  bindings["handoff-fresh"] = f.handoffBindings; bindings["handoff-amendment"] = amendment; bindings["pair-signoff"] = f.bindings;
  for (const [id, payload] of [["review-matrix", matrix], ["review-objective", objective]] as const) {
    const e = f.registry.entries.find(e => e.id === id)!; e.source.sha256 = digest("{{payload}}"); e.bindings = { payload: { type: "json", required: true } }; e.capabilities.render = true; e.capabilities.validate = true;
    writeFileSync(join(f.root, e.source.path), "{{payload}}"); bindings[id] = { payload };
  }
  return { ...f, selection: f.save(), allBindings: bindings, amendmentPairBindings: { ...f.bindings, ...amendment } };
}
