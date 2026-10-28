// Disposable synthetic content only; no canonical prose or human decisions.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowProducerBindings } from "../templates/binding-contracts.js";
import { digest, TEMPLATE_IDS, type TemplateRegistry } from "../templates/schema.js";
export function templateFixture() {
  const root = mkdtempSync(join(tmpdir(), "pa-template-"));
  mkdirSync(join(root, "contracts")); mkdirSync(join(root, "skills/templates"), { recursive: true });
  const registry: TemplateRegistry = { schemaVersion: "pa-template-registry/v1", configRevision: "a".repeat(40), runtimeContract: "pa-template-runtime/v1", entries: TEMPLATE_IDS.map((id) => {
    const source = "# Synthetic fixture\r\n## Body\r\n{{ticket}}\r\n";
    writeFileSync(join(root, `skills/templates/${id}.md`), source);
    const gated = ["handoff-fresh", "handoff-amendment", "pair-signoff", "review-matrix", "review-objective"].includes(id);
    return { id, revision: "1", purpose: "Synthetic disposable structural fixture", owner: "fixture/config", contexts: [{ runtime: "pi", team: "*", mode: "*" }], source: { path: `skills/templates/${id}.md`, sha256: digest(source), selector: null }, bindings: workflowProducerBindings(id) ?? { ticket: { type: "ticket", required: true } }, validation: { kind: id === "review-matrix" ? "review-matrix" : id === "review-objective" ? "review-objective" : id === "pair-signoff" ? "pair-signoff" : id.startsWith("handoff-") ? "task-handoff" : "sections", sections: gated ? [] : ["## Body"] }, capabilities: { render: !gated, validate: !gated, reason: gated ? "Exact consumer fixture unavailable" : "Structural fixture only", authorityGate: "Real human decision/native evidence remains separate" } };
  }) };
  function save() { const bytes = JSON.stringify(registry); writeFileSync(join(root, "contracts/templates-v1.json"), bytes); return { root, configRevision: registry.configRevision, registrySha256: digest(bytes) }; }
  return { root, registry, save, selection: save(), dispose: () => rmSync(root, { recursive: true, force: true }) };
}
