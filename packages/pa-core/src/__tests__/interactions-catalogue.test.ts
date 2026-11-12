import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { interactionCatalogue, validateInteractionCatalogue } from "../interactions/catalogue.js";
import { SOURCE_ONLY_AVAILABILITY } from "../interactions/contract.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const operation = (id: string) => {
  const row = interactionCatalogue.find(entry => entry.operationId === id);
  assert.ok(row, `missing operation: ${id}`);
  return row;
};

test("source catalogue is unique, owner-bound and explicitly not installed or admitted", () => {
  assert.deepEqual(validateInteractionCatalogue(interactionCatalogue), []);
  for (const row of interactionCatalogue) {
    assert.equal(row.nativeBinding, null, "a source-only catalogue must not infer a live registered binding");
    assert.equal(row.delegationBinding, null, "routing intent is not a verified service binding");
    assert.equal(row.requestSchemaRef, null, "this source-only catalogue does not claim a live family schema binding");
    assert.equal(row.resultSchemaRef, null);
    assert.ok(row.reason.length > 0 && row.supportedNextStep.length > 0);
    assert.ok(row.requiredContext.length > 0);
    assert.ok(readFileSync(resolve(root, row.sourceHandler.split("#")[0]!), "utf8").length > 0);
  }
  assert.deepEqual(SOURCE_ONLY_AVAILABILITY, {
    configured: "unproven", installed: "unproven", registeredInSession: "unproven", available: "unproven", admitted: "not-checked",
  });
});

test("catalogue validator rejects duplicate identities, orphan aliases, invalid bindings and unsafe classifications", () => {
  const rows = interactionCatalogue;
  assert.ok(validateInteractionCatalogue([...rows, rows[0]!]).includes("duplicate-operation"));
  assert.ok(validateInteractionCatalogue(rows.filter(row => row.operationId !== "health.save")).includes("missing-effect-variant"));
  assert.ok(validateInteractionCatalogue([...rows, { ...rows[0]!, operationId: "new.alias", aliases: [rows[0]!.cliForms[0]!] }]).includes("duplicate-cli-form"));
  assert.ok(validateInteractionCatalogue(rows.map(row => row.operationId === "registry.amend" ? { ...row, replacementId: "absent.operation" } : row)).includes("orphan-replacement"));
  assert.ok(validateInteractionCatalogue([{ ...rows[0]!, nativeBinding: { tool: "pa_invented", action: "execute" } }]).includes("unbound-schema"));
  assert.ok(validateInteractionCatalogue([{ ...operation("health.save"), effectClass: "read" }]).includes("effect-regression"));
  assert.ok(validateInteractionCatalogue([{ ...operation("status.wait"), effectClass: "read" }]).includes("effect-regression"));
  assert.ok(validateInteractionCatalogue([{ ...operation("signal.collect.preview"), targetDisposition: "native-supported" }]).includes("operator-boundary"));
});

test("hidden effect variants and deprecated/unsupported forms remain explicit", () => {
  assert.equal(operation("health.save").effectClass, "write");
  assert.equal(operation("status.wait").effectClass, "write");
  assert.equal(operation("serve.status").effectClass, "write", "CLI status can remove stale PID state");
  assert.equal(operation("deploy.preview").effectClass, "write");
  assert.equal(operation("registry.clean.apply").targetDisposition, "operator-only");
  assert.equal(operation("registry.sweep.apply").targetDisposition, "operator-only");
  assert.equal(operation("signal.collect.preview").effectClass, "sensitive");
  assert.equal(operation("pi.reconcile-child.apply").effectClass, "write");
  assert.equal(operation("registry.amend").replacementId, "registry.update");
  assert.equal(operation("deploy.agent-model").targetDisposition, "intentionally-unsupported");
  assert.equal(operation("evaluate.agent-model").targetDisposition, "intentionally-unsupported");
  assert.ok(operation("semantic.rebuild").aliases.includes("semantic refresh"));
  assert.ok(operation("serve.status").aliases.includes("serve-status"));
  assert.ok(operation("codectx.query.function").aliases.includes("codectx query fn"));
});

test("status owner routes are inventoried without promoting source discovery to authority", () => {
  for (const action of ["inspect", "set"]) {
    const row = operation(`ticket.status.${action}`);
    assert.deepEqual(row.channels, ["cli", "native"]);
    assert.deepEqual(row.nativeForms, [`pa_ticket_status:${action}`]);
    assert.equal(row.effectClass, action === "inspect" ? "read" : "write");
    assert.equal(row.nativeBinding, null);
  }
});

test("native-only owners are accounted for without inventing CLI commands or grants", () => {
  for (const id of ["ticket.intake.create", "document.native.confirm", "document.native.branch-inspect", "workspace.run", "workflow.native.request-step", "decision.native.adopt", "preparation.retry", "execution.report", "phase-report.observe-delivery", "feature.update", "borrow.approval"]) {
    const row = operation(id);
    assert.deepEqual(row.channels, ["native"]);
    assert.deepEqual(row.cliForms, []);
    assert.equal(row.nativeBinding, null);
    assert.equal(row.nativeForms.length, 1);
  }
  assert.equal(operation("execution.report").effectClass, "write", "report publishes durable evidence");
  assert.equal(operation("document.native.check").effectClass, "read", "structural checks do not freeze snapshots");
  assert.equal(operation("preparation.status").effectClass, "read");
  assert.equal(operation("workspace.run").effectClass, "write");
  assert.equal(operation("document.native.publication-diagnose").effectClass, "read");
  assert.equal(operation("document.native.publication-retire").effectClass, "write");
  assert.deepEqual(operation("document.native.publication-retire").channels, ["native"]);
  assert.ok(validateInteractionCatalogue(interactionCatalogue.map(row => row.operationId === "workspace.run" ? { ...row, channels: ["cli"] } : row)).includes("invalid-channel"));
});

test("conservative source inventory rejects any changed or added dispatch source pending semantic reconciliation", () => {
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  const commandDir = "packages/pa-core/src/cli/commands";
  const files = readdirSync(resolve(root, commandDir)).filter(name => name.endsWith(".ts")).map(name => `${commandDir}/${name}`);
  for (const path of files) assert.ok(Object.hasOwn(manifest.sources, path), `unreviewed command source: ${path}`);
  for (const [path, sha256] of Object.entries(manifest.sources)) {
    assert.equal(createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex"), sha256,
      `${path} changed: reconcile operations/aliases/effect variants before renewing the source snapshot`);
  }
  for (const row of interactionCatalogue) assert.ok(Object.hasOwn(manifest.sources, row.sourceHandler.split("#")[0]!), `untracked handler ${row.sourceHandler}`);
  // A source guard is deliberately conservative, not a parser-based completeness proof.
  const baseline = readFileSync(resolve(root, "packages/pa-core/src/cli/core-command.ts"));
  const changed = Buffer.concat([baseline, Buffer.from('\n// fixture: new unlisted dispatch\n')]);
  assert.notEqual(createHash("sha256").update(changed).digest("hex"), manifest.sources["packages/pa-core/src/cli/core-command.ts"]);
});
