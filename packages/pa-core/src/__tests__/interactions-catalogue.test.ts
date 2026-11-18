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
  assert.equal(operation("pi.inspect-recovery").effectClass, "read");
  assert.equal(operation("pi.ticket-worktree.inspect").effectClass, "read");
  assert.equal(operation("pi.ticket-worktree.refresh-head").effectClass, "write");
  assert.equal(operation("pi.ticket-worktree.refresh-head").targetDisposition, "operator-only");
  assert.deepEqual(operation("pi.ticket-worktree.refresh-head").nativeForms, []);
  assert.ok(validateInteractionCatalogue(interactionCatalogue.map(row => row.operationId === "pi.ticket-worktree.refresh-head" ? { ...row, effectClass: "read" } : row)).includes("effect-regression"));
  assert.equal(operation("registry.amend").replacementId, "registry.update");
  assert.equal(operation("deploy.agent-model").targetDisposition, "intentionally-unsupported");
  assert.equal(operation("evaluate.agent-model").targetDisposition, "intentionally-unsupported");
  assert.ok(operation("semantic.rebuild").aliases.includes("semantic refresh"));
  assert.ok(operation("serve.status").aliases.includes("serve-status"));
  assert.ok(operation("codectx.query.function").aliases.includes("codectx query fn"));
});

test("PPA auto refresh writes only coordination data and never becomes a native approval/launch binding", () => {
  for (const id of ["auto.help", "auto.list", "auto.status"]) assert.equal(operation(id).effectClass, "read");
  const scan = operation("auto.scan");
  assert.equal(scan.effectClass, "write"); assert.deepEqual(scan.cliForms, ["auto scan", "auto --json"]);
  assert.equal(operation("auto.foreground").effectClass, "launch");
  assert.equal(operation("auto.tick").effectClass, "write");
  assert.equal(operation("auto.units").effectClass, "read");
  assert.deepEqual(operation("auto.foreground").nativeForms, []);
  assert.deepEqual(scan.nativeForms, []); assert.deepEqual(scan.channels, ["cli"]); assert.equal(scan.nativeBinding, null);
  assert.match(scan.reason, /not a pure read/);
  assert.ok(validateInteractionCatalogue(interactionCatalogue.map(row => row.operationId === "auto.scan" ? { ...row, effectClass: "read" } : row)).includes("effect-regression"));
  assert.ok(validateInteractionCatalogue(interactionCatalogue.filter(row => row.operationId !== "auto.scan")).includes("missing-effect-variant"));
});
test("shortlist foreground is a provider/choice effect while retained report pages stay observational", () => {
  const foreground = operation("auto.shortlist.foreground"), read = operation("auto.shortlist.read");
  assert.equal(foreground.effectClass, "launch"); assert.equal(read.effectClass, "read");
  assert.deepEqual(foreground.nativeForms, []); assert.equal(foreground.nativeBinding, null); assert.equal(foreground.delegationBinding, null);
  assert.match(foreground.reason, /No ranking\/default\/noninteractive/);
  assert.ok(validateInteractionCatalogue(interactionCatalogue.map(row => row.operationId === foreground.operationId ? { ...row, effectClass: "read" } : row)).includes("effect-regression"));
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

test("new handoff source dispatch is explicit and does not widen retained document owners or claim installed admission", () => {
  for (const action of ["intake", "stage", "plan", "prepare-review", "review", "revoke", "publish", "complete-branch", "queue", "open", "status", "show", "preflight", "request", "decide", "refresh"]) {
    const row = operation(`handoff.${action}`);
    assert.deepEqual(row.nativeForms, [`pa_handoff:${action}`]); assert.deepEqual(row.cliForms, []);
    assert.equal(row.nativeBinding, null); assert.equal(row.sourceHandler, "packages/pi-pa/src/pi-extension/handoff-tool.ts");
    assert.equal(row.effectClass, ["status", "show", "preflight"].includes(action) ? "read" : action === "open" ? "resource" : "write");
  }
  for (const id of ["document.native.plan", "document.native.complete-branch", "document.native.open"]) {
    assert.equal(interactionCatalogue.some(row => row.operationId === id), false);
  }
  // The new tool is selected only by its explicit immutable capability. Retained
  // document/session modules do not directly dispatch low-level finite owners.
  assert.doesNotMatch(readFileSync(resolve(root, "packages/pa-core/src/index.ts"), "utf8"), /(?:handoff-git|handoff-native-branch)\.js/);
  for (const path of ["packages/pi-pa/src/pi-extension/document-tool.ts", "packages/pi-pa/src/document-session.ts"]) {
    const source = readFileSync(resolve(root, path), "utf8");
    assert.doesNotMatch(source, /(?:handoff-native-branch|handoff-git|handoff-contract|handoff-intake|handoff-planning|handoff-lifecycle|handoff-review|handoff-publication|reader-publication)\.js/);
  }
  // Primer resource composition is text projection, not another CLI dispatcher.
  assert.equal(operation("document.native.branch-inspect").effectClass, "read");
  assert.equal(operation("document.native.branch-inspect").nativeBinding, null);
});

test("local review discovery distinguishes unauthenticated journal writes, listener resources and native-only effects", () => {
  for (const [id, effect] of [["document.review.help", "read"], ["document.review.stdin", "write"], ["document.review.serve", "resource"]] as const) {
    const row = operation(id);
    assert.equal(row.effectClass, effect);
    assert.deepEqual(row.channels, ["cli"]); assert.deepEqual(row.nativeForms, []);
    assert.equal(row.nativeBinding, null);
    assert.match(row.supportedNextStep, /ppa document review --help/);
    assert.doesNotMatch(row.supportedNextStep, /current session/);
    assert.match(row.requiredContext.join(" "), /no caller authentication/);
    assert.doesNotMatch(row.requiredContext.join(" "), /authenticated caller/);
  }
  assert.match(operation("document.review.stdin").reason, /show reads; request\/revoke persist/);
  assert.match(operation("document.review.serve").reason, /allocates a server resource/);
  assert.match(operation("handoff.revoke").owner, /v2 request-only.*original pre-request/);
  for (const id of ["document.review.stdin", "document.review.serve", "handoff.request", "handoff.decide", "handoff.refresh"]) {
    assert.ok(validateInteractionCatalogue(interactionCatalogue.map(row => row.operationId === id ? { ...row, effectClass: "read" } : row)).includes("effect-regression"));
    assert.ok(validateInteractionCatalogue(interactionCatalogue.filter(row => row.operationId !== id)).includes("missing-effect-variant"));
  }
  for (const action of ["preflight", "refresh", "publish", "complete-branch", "queue"]) {
    assert.deepEqual(operation(`handoff.${action}`).cliForms, []);
    assert.equal(interactionCatalogue.some(row => row.cliForms.some(form => form.startsWith(`document review ${action}`))), false);
  }
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  for (const path of ["packages/pa-core/src/documents/local-review.ts", "packages/pa-core/src/documents/handoff-preflight.ts",
    "packages/pa-core/src/tickets/handoff-intent.ts", "packages/pi-pa/src/local-review-cli.ts", "packages/pi-pa/src/local-review-server.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked local review owner: ${path}`);
  }
});

test("general server review opt-in remains an operator resource, never decision or runner authority", () => {
  for (const [id, form] of [["serve.start", "serve --local-review"], ["serve.restart", "serve restart --local-review"]] as const) {
    const row = operation(id);
    assert.ok(row.cliForms.includes(form));
    assert.equal(row.effectClass, "resource"); assert.equal(row.targetDisposition, "operator-only");
    assert.deepEqual(row.channels, ["cli"]); assert.deepEqual(row.nativeForms, []);
    assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null);
    assert.match(row.reason, /allocates a server resource/);
    assert.match(row.reason, /POST \/api\/documents\/local-review/);
    assert.match(row.reason, /127\.0\.0\.1.*::1/);
    assert.match(row.reason, /local-unverified.*not authenticated human consent/);
    assert.match(row.reason, /No CLI\/API effect parity/);
    assert.match(row.reason, /no publication, ref\/link, queue or runner authority/);
    assert.match(row.requiredContext.join(" "), /no caller authentication/);
    assert.doesNotMatch(row.requiredContext.join(" "), /authenticated caller/);
    assert.match(row.supportedNextStep, /serve --help/);
    assert.doesNotMatch(row.supportedNextStep, /current session/);
    assert.ok(validateInteractionCatalogue(interactionCatalogue.map(entry => entry.operationId === id ? { ...entry, effectClass: "read" } : entry)).includes("effect-regression"));
    assert.ok(validateInteractionCatalogue(interactionCatalogue.map(entry => entry.operationId === id ? { ...entry, targetDisposition: "native-supported" } : entry)).includes("operator-boundary"));
    assert.ok(validateInteractionCatalogue(interactionCatalogue.filter(entry => entry.operationId !== id)).includes("missing-effect-variant"));
  }
  assert.ok(operation("serve.restart").aliases.includes("restart --local-review"));
  for (const id of ["serve.stop", "serve.status"]) {
    assert.equal([...operation(id).cliForms, ...operation(id).aliases].some(form => form.includes("--local-review")), false);
  }
  for (const action of ["publish", "complete-branch", "queue", "refresh"]) {
    assert.deepEqual(operation(`handoff.${action}`).channels, ["native"]);
    assert.deepEqual(operation(`handoff.${action}`).cliForms, []);
  }
  // HTTP is a transport dependency, not a fictitious channel/tool in the
  // source discovery contract, which supports only CLI/native descriptions.
  for (const row of interactionCatalogue) {
    assert.equal(row.nativeForms.some(form => /pa_local_review|pa_review_server/.test(form)), false);
  }
});

test("Analyst identity, own-deployment sources and review convergence retain finite effect owners", () => {
  assert.match(operation("deploy.launch").reason, /analyst\/analyze.*v2/);
  assert.match(operation("deploy.launch").reason, /no generic ticket privilege/i);
  for (const action of ["inspect", "set"]) {
    assert.match(operation(`ticket.status.${action}`).reason, /natively bound analyst\/analyze/);
  }
  const draft = operation("document.native.draft"), check = operation("document.native.check"), freeze = operation("document.native.freeze");
  assert.equal(draft.effectClass, "write"); assert.equal(check.effectClass, "read"); assert.equal(freeze.effectClass, "write");
  for (const row of [draft, check, freeze]) {
    assert.deepEqual(row.channels, ["native"]); assert.deepEqual(row.cliForms, []);
    assert.match(row.reason, /own-deployment.*selected policy/);
    assert.match(row.reason, /no repository write/);
  }
  assert.match(operation("handoff.review").reason, /original request.*canonical.*decision/);
  assert.match(operation("handoff.review").reason, /detachment.*not.*Cancel/);
  assert.match(operation("handoff.review").reason, /v1.*foreground/);
  const store = readFileSync(resolve(root, "packages/pa-core/src/tickets/store.ts"), "utf8");
  assert.match(store, /privileged: deployment\.team !== "analyst"/);
  const session = readFileSync(resolve(root, "packages/pi-pa/src/document-session.ts"), "utf8");
  assert.match(session, /documentTicketMutationContext\(caller: PiDocumentCaller, tool: "pa_document" \| "pa_handoff" \| "pa_ticket_status"\)/);
  assert.match(session, /if \(!capabilityToolSelected\(caller\.capabilities\.policy, tool\)\) throw new DocumentPackageError\("DOCUMENT_AUTHORITY"\)/);
});

test("PAP-316 inventory covers selection, source intake and real bridge ingress owners", () => {
  // Typed repository-owned fixture, not an unvalidated production input boundary.
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  for (const path of ["packages/pa-core/src/analyst-resource-selection.ts", "packages/pa-core/src/mode-capabilities.ts",
    "packages/pa-core/src/mode-capability-selection.ts", "packages/pa-core/src/selected-config-source.ts",
    "packages/pa-core/src/deploy/plan.ts", "packages/pa-core/src/deploy/repository-admission.ts",
    "packages/pi-pa/src/process-identity.ts", "packages/pa-core/src/documents/package-contract.ts",
    "packages/pa-core/src/documents/package-tools.ts", "packages/pa-core/src/documents/package-service.ts",
    "packages/pa-core/src/agent-api/routes/local-review.ts", "packages/pa-core/src/agent-api/index.ts",
    "packages/pa-core/src/serve-lifecycle.ts", "packages/pa-core/src/cli/commands/serve.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked PAP-316 effect/identity dependency: ${path}`);
  }
});

test("PAP-318 reconciles bounded transport and explicit v3 profile admission without new public effects", () => {
  assert.match(operation("deploy.launch").reason, /Explicit v3 pa-readonly-document\/v1/);
  assert.match(operation("deploy.launch").reason, /missing mode\/default cannot fall through/);
  assert.match(operation("deploy.launch").reason, /bounded prompt references/);
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8"));
  for (const path of ["packages/pa-core/src/readonly-document-config.ts", "packages/pi-pa/src/prompt-transport.ts", "packages/pi-pa/src/prompt-preload.ts", "packages/pi-pa/src/background-runner.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked PAP-318 admission/transport/lifecycle dependency: ${path}`);
  }
  for (const row of interactionCatalogue) assert.equal(row.nativeForms.some(form => /pa_prompt|pa_readonly_profile/.test(form)), false);
});

test("PAP-298 selected host changes existing launch/resume mechanics, not public commands or grants", () => {
  for (const id of ["deploy.launch", "deploy.resume"]) {
    const row = operation(id);
    assert.equal(row.effectClass, "launch"); assert.deepEqual(row.channels, ["cli"]);
    assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null);
  }
  assert.match(operation("deploy.launch").reason, /no caller-controlled host selector/);
  assert.match(operation("deploy.resume").reason, /before allocation/);
  for (const row of interactionCatalogue) {
    assert.equal(row.cliForms.some(form => /--selected-pi|--document-root|--hardlink-grant/.test(form)), false);
    assert.equal(row.nativeForms.some(form => /pa_selected_pi|pa_hardlink/.test(form)), false);
  }
  const manifest = JSON.parse(readFileSync(resolve(root, "packages/pa-core/src/interactions/source-inventory.json"), "utf8"));
  for (const path of ["nix/selected-pi-production-payload.nix", "nix/selected-pi-production-fixture.nix",
    "packages/pi-pa/runtime/selected-host-entry.c", "packages/pi-pa/runtime/selected-pi-host.mjs", "packages/pi-pa/runtime/selected-pi-environment.json",
    "packages/pi-pa/src/adapter.ts", "packages/pi-pa/src/native-host.ts", "packages/pi-pa/src/selected-pi-launch.ts", "packages/pi-pa/src/selected-pi-resume.ts",
    "packages/pi-pa/src/pi-extension/read-publication.ts", "packages/pa-core/src/runtime-api/types.ts", "scripts/dev/patch-selected-pi.py"])
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked selected-host authority/contract source: ${path}`);
});

test("managed Pi skills and protected-review extensions retain independent launch boundaries", () => {
  for (const id of ["deploy.launch", "deploy.resume", "deploy.rogue-one"]) {
    const row = operation(id);
    assert.equal(row.effectClass, "launch");
    assert.deepEqual(row.channels, ["cli"]);
    assert.equal(row.nativeBinding, null);
    assert.equal(row.delegationBinding, null);
  }
  assert.ok(operation("deploy.launch").cliForms.includes("deploy --background"));
  for (const row of interactionCatalogue) {
    assert.equal(row.cliForms.some(form => /--pi-agent-dir|--allow-extensions|--discovery/.test(form)), false);
    assert.equal(row.nativeForms.some(form => /pa_extension|pa_skill|pa_discovery/.test(form)), false);
  }
  const host = readFileSync(resolve(root, "packages/pi-pa/runtime/selected-pi-host.mjs"), "utf8");
  assert.match(host, /args\[\+\+index\] === selection\.extensionModule && \+\+extensionCount === 1/);
  assert.match(host, /fs\.realpathSync\(path\) !== selection\.extensionModule/);
  const adapter = readFileSync(resolve(root, "packages/pi-pa/src/adapter.ts"), "utf8");
  // Managed skill discovery is disabled independently of the stricter protected
  // review extension boundary. Neither check substitutes for the other.
  assert.match(adapter, /if \(plan\) \{\s*(?:\/\/[^\n]*\n\s*)*args\.push\("--no-skills"\);/);
  assert.match(adapter, /if \(plan\.reviewCheckout \|\| protectedValidationLaunch\) args\.push\("--no-extensions"\);/);
  assert.match(adapter, /if \(config\.managed \|\| config\.validationHandoffPath \|\| reviewerContext\) args\.push\("--no-skills"\);/);
  assert.match(adapter, /if \(config\.validationHandoffPath \|\| reviewerContext\) args\.push\("--no-extensions"\);/);
  assert.match(adapter, /if \(plan\.modeCapabilityBinding\?\.schemaVersion !== "pa-mode-capability-binding\/v2"\) \{\s*for \(const skill of plan\.skills\) args\.push\("--skill", skill\.path\);/);
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

test("PAP-303 inventory tracks private observation/lifecycle dependencies without advertising peer effects", () => {
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  for (const file of ["source-guard-coverage.ts", "herdr-lifecycle.ts", "herdr-peer-admission.ts", "herdr-peer-exchange.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, `packages/pi-pa/src/pi-extension/${file}`), `untracked PAP-303 dependency: ${file}`);
  }
  for (const operation of interactionCatalogue) {
    assert.equal([...operation.cliForms, ...operation.nativeForms].some(form => /herdr|pa_peer|peer.request/.test(form)), false,
      "source reconciliation must not invent an available peer request operation");
  }
});
