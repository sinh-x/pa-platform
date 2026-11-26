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

test("PAP-334 native ticket administration has exact finite forms, authentication owners and no extra effects", () => {
  const effects = { inspect: "read", create: "write", update: "write", "set-status": "write", comment: "write" } as const;
  assert.deepEqual(interactionCatalogue.filter(row => row.operationId.startsWith("ticket.native.")).map(row => row.operationId).sort(),
    Object.keys(effects).map(action => `ticket.native.${action}`).sort());
  for (const [action, effect] of Object.entries(effects)) {
    const row = operation(`ticket.native.${action}`);
    assert.deepEqual(row.nativeForms, [`pa_ticket:${action}`]);
    assert.deepEqual(row.cliForms, []); assert.deepEqual(row.channels, ["native"]);
    assert.deepEqual(row.aliases, action === "comment" ? ["pa_ticket:comment(id,author,content)"] : []);
    assert.equal(row.sourceHandler, "packages/pi-pa/src/pi-extension/ticket-tool.ts");
    assert.match(row.owner, /ticketAdminService \/ TicketStore; authenticatePiTicketCaller/);
    assert.equal(row.effectClass, effect);
    assert.match(row.reason, /any exact registered target project independently of team\/mode/);
    assert.match(row.reason, /environment labels alone are not authentication/);
    assert.match(row.reason, /anchor recorder covers all managed teams\/modes/);
    assert.match(row.reason, /no overlapping source operation or pending restart/);
    assert.match(row.reason, /never a phase-check pass or failure reset/);
    assert.match(row.reason, /No source\/Git, workflow, approval, publication, queue, resource or launch authority/);
    assert.match(row.requiredContext.join(" "), /target need not be the launch ticket/);
    assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null);
    assert.equal(row.requestSchemaRef, null); assert.equal(row.resultSchemaRef, null);
    for (const wrong of ["read", "write", "resource", "launch"] as const) {
      if (wrong !== effect) assert.ok(validateInteractionCatalogue(interactionCatalogue.map(entry => entry.operationId === row.operationId ? { ...entry, effectClass: wrong } : entry)).includes("effect-regression"));
    }
    assert.ok(validateInteractionCatalogue(interactionCatalogue.filter(entry => entry.operationId !== row.operationId)).includes("missing-effect-variant"));
    assert.ok(validateInteractionCatalogue(interactionCatalogue.map(entry => entry.operationId === row.operationId ? { ...entry, delegationBinding: { owner: "invented", channel: "native" } } : entry)).includes("source-binding-regression"));
  }
  assert.match(operation("ticket.native.update").reason, /Arrays replace.*no status, refs, primary, Git/);
  assert.match(operation("ticket.native.update").reason, /inspect-only, not idempotent replay authority/);
  assert.match(operation("ticket.native.set-status").reason, /existing durable status-intent owner/);
  assert.match(operation("ticket.native.comment").reason, /configured same-team agent, never identity or permission/);
});

test("PAP-334 generic and selected status owners stay distinct from unchanged finite intake", () => {
  const generic = operation("ticket.lifecycle");
  assert.deepEqual(generic.cliForms, ["ticket update --status", "ticket update --assignee", "ticket update --force"]);
  assert.equal(generic.effectClass, "write"); assert.deepEqual(generic.nativeForms, []);
  assert.match(generic.reason, /authenticated REST PATCH \/api\/tickets\/:id/);
  assert.match(generic.reason, /independent of team\/mode or document profile/);
  assert.match(generic.reason, /Completed history is not a blanket stage restriction/);
  assert.match(generic.reason, /Deletion restrictions remain separate/);
  for (const action of ["inspect", "set"]) {
    const row = operation(`ticket.status.${action}`);
    assert.match(row.reason, /selected finite effective-identity admission/);
    assert.match(row.reason, /Any exact registered target project/);
    assert.match(row.reason, /checks remain stricter than generic administration/);
    assert.deepEqual(row.nativeForms, [`pa_ticket_status:${action}`]);
  }
  const intake = interactionCatalogue.filter(row => row.operationId.startsWith("ticket.intake."));
  assert.deepEqual(intake.map(row => row.operationId).sort(), ["capabilities", "inspect", "reuse", "create", "patch-planning"].map(action => `ticket.intake.${action}`).sort());
  for (const row of intake) {
    assert.deepEqual(row.nativeForms, [`pa_ticket_intake:${row.operationId.slice("ticket.intake.".length)}`]);
    assert.deepEqual(row.cliForms, []); assert.deepEqual(row.channels, ["native"]);
    assert.equal(row.effectClass, ["create", "patch-planning"].some(action => row.operationId.endsWith(`.${action}`)) ? "write" : "read");
    assert.match(row.owner, /v4 or explicitly policy-selected ticket.intake/);
  }
  assert.match(operation("ticket.intake.patch-planning").owner, /no other current\/historical deployment association/);
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  // Only CLI command files are auto-discovered by the guard below. Imported
  // services/authentication/barrier owners require explicit manifest coverage.
  for (const path of ["packages/pa-core/src/tickets/admin-service.ts", "packages/pa-core/src/tickets/index.ts",
    "packages/pa-core/src/agent-api/routes/tickets.ts", "packages/pi-pa/src/ticket-session.ts",
    "packages/pi-pa/src/native-execution-administration.ts", "packages/pi-pa/src/native-execution-tools.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked PAP-334 administration/authentication/barrier source: ${path}`);
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
  for (const action of ["intake", "stage", "plan", "prepare-review", "review", "revoke", "publish", "complete-branch", "queue", "open", "status", "plan-status", "show", "preflight", "request", "decide", "refresh"]) {
    const row = operation(`handoff.${action}`);
    assert.deepEqual(row.nativeForms, [`pa_handoff:${action}`]); assert.deepEqual(row.cliForms, []);
    assert.equal(row.nativeBinding, null); assert.equal(row.sourceHandler, "packages/pi-pa/src/pi-extension/handoff-tool.ts");
    assert.equal(row.effectClass, ["status", "plan-status", "show", "preflight"].includes(action) ? "read" : action === "open" ? "resource" : "write");
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

test("historical Analyst selection, own-deployment sources and review convergence retain finite effect owners", () => {
  assert.match(operation("deploy.launch").reason, /Historical analyst\/analyze v2 bindings remain selection contracts only/);
  assert.match(operation("deploy.launch").reason, /ticket administration grants no workflow, source\/Git, branch or approval authority/i);
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
  const session = readFileSync(resolve(root, "packages/pi-pa/src/document-session.ts"), "utf8");
  assert.match(session, /documentTicketMutationContext\(caller: PiDocumentCaller, tool: "pa_document" \| "pa_handoff" \| "pa_ticket_status"\)/);
  assert.match(session, /if \(caller\.capabilities && !capabilityToolSelected\(caller\.capabilities\.policy, tool\)\) throw new DocumentPackageError\("DOCUMENT_AUTHORITY"\)/);
});

test("PAP-316 inventory covers selection, source intake and real bridge ingress owners", () => {
  // Typed repository-owned fixture, not an unvalidated production input boundary.
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  for (const path of ["packages/pa-core/src/analyst-resource-selection.ts", "packages/pa-core/src/mode-capabilities.ts",
    "packages/pa-core/src/mode-capability-selection.ts", "packages/pa-core/src/selected-config-source.ts",
    "packages/pa-core/src/deploy/plan.ts", "packages/pa-core/src/deploy/repository-admission.ts",
    "packages/pa-core/src/deploy/repository-ref-error.ts", "packages/pa-core/src/deploy/ticket-concurrency.ts",
    "packages/pi-pa/src/process-identity.ts", "packages/pa-core/src/documents/package-contract.ts",
    "packages/pa-core/src/documents/package-tools.ts", "packages/pa-core/src/documents/package-service.ts",
    "packages/pa-core/src/agent-api/routes/local-review.ts", "packages/pa-core/src/agent-api/index.ts",
    "packages/pa-core/src/serve-lifecycle.ts", "packages/pa-core/src/cli/commands/serve.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked PAP-316 effect/identity dependency: ${path}`);
  }
});

test("PAP-329 ordinary startup changes admission, not public forms, effects or native authority", () => {
  const launch = operation("deploy.launch"), resume = operation("deploy.resume");
  assert.match(launch.reason, /Profile-free interactive modes.*without native workflow, branch or approval admission/);
  assert.match(launch.reason, /Sensitive-command\/data safeguards.*retained checkout custody still apply/);
  assert.match(launch.reason, /no native document or builder tools/);
  assert.match(resume.reason, /same team, mode, runtime, ticket and physical roots/);
  assert.match(resume.reason, /cannot reclassify a retained document, builder, review or checkout-bound session/);
  assert.deepEqual(launch.cliForms, ["deploy <team>", "deploy --background"]);
  assert.deepEqual(resume.cliForms, ["deploy --resume"]);
  for (const row of [launch, resume]) {
    assert.equal(row.effectClass, "launch");
    assert.deepEqual(row.channels, ["cli"]);
    assert.deepEqual(row.nativeForms, []);
    assert.equal(row.nativeBinding, null);
    assert.equal(row.delegationBinding, null);
  }
  for (const id of ["execution.plan", "execution.report", "phase-report.capture"]) {
    assert.equal(operation(id).nativeBinding, null, "source inventory does not register protected tools for ordinary sessions");
  }
});

test("PAP-318 retains bounded transport and v3 selection contracts without claiming current execution admission", () => {
  assert.match(operation("deploy.launch").reason, /Explicit v3 pa-readonly-document\/v1 execution is blocked/);
  assert.match(operation("deploy.launch").reason, /missing mode\/default cannot fall through/);
  assert.match(operation("deploy.launch").reason, /bounded prompt references/);
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8"));
  for (const path of ["packages/pa-core/src/readonly-document-config.ts", "packages/pi-pa/src/prompt-transport.ts", "packages/pi-pa/src/prompt-preload.ts", "packages/pi-pa/src/background-runner.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked PAP-318 admission/transport/lifecycle dependency: ${path}`);
  }
  for (const row of interactionCatalogue) assert.equal(row.nativeForms.some(form => /pa_prompt|pa_readonly_profile/.test(form)), false);
});

test("PAP-334 P2b catalogue describes interim rejection, not working confinement, execution or adoption", () => {
  const launch = operation("deploy.launch"), resume = operation("deploy.resume"), preview = operation("deploy.preview"), rogue = operation("deploy.rogue-one");
  assert.match(launch.reason, /^Protected execution is not started\./);
  assert.match(launch.reason, /interim static fail-closed checker \(REPOSITORY_ISOLATION_UNAVAILABLE\)/);
  for (const row of [launch, resume]) {
    assert.match(row.reason, /public Analyst (?:outside the bounded ordinary foreground Pi analyst\/analyze route|protected history), legacy requirements\/analyze and (?:the )?existing v3 pa-readonly-document\/v1/);
    assert.match(row.reason, /no usable confined executor or scope-grant override/);
    assert.match(row.reason, /not working execution or adoption/);
    assert.match(row.reason, /not universal route qualification or installed availability/);
    assert.equal(row.effectClass, "launch");
    assert.equal(row.targetDisposition, "native-supported", "source routing intent remains distinct from protected execution admission");
    assert.deepEqual(row.channels, ["cli"]); assert.deepEqual(row.nativeForms, []);
    assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null);
    assert.equal(row.requestSchemaRef, null); assert.equal(row.resultSchemaRef, null);
    assert.doesNotMatch(row.reason, /v3 pa-readonly-document\/v1 starts bind|analyst\/analyze retains its fixed v2 binding/);
  }
  assert.match(launch.reason, /Profile-free interactive modes outside these protected selections/);
  assert.match(launch.reason, /all v1\/v2\/v3 capability bindings.*plan.environment, original environments and their merged overlays/);
  assert.match(launch.reason, /writer label cannot erase protected evidence/);
  assert.match(launch.reason, /Pi spawn accepts only an adapter-issued single-use fresh session ID/);
  assert.match(launch.reason, /not installed session-store race qualification/);
  assert.match(launch.reason, /Raw Pi\/OPA runners, including the executable entrypoint, check inside their lifecycle before consuming configuration, runtime spawn or custody transfer/);
  assert.match(launch.reason, /retaining rejected configurations and existing claims rather than emitting terminal registry reconciliation/);
  assert.match(resume.reason, /cannot be reclassified as rogue-one/);
  assert.match(resume.reason, /raw current\/start\/event rows and every resumed ancestor in one read transaction/);
  assert.match(resume.reason, /retained requirements-document-\* or readonly-document-policy\/\* note refuses downgrade even with a writer label or missing binding/);
  assert.match(resume.reason, /Missing, unreadable or malformed native prior evidence fails closed/);
  assert.match(resume.reason, /existing-files-only registry reads do not initialize a database or allocate missing WAL\/SHM sidecars/);
  assert.match(resume.reason, /Direct adapter resume requires the native prior deployment ID, not just a session token/);
  assert.match(resume.reason, /private runtime-specific session-owner.ts readers share safe existing-file I\/O and bind the exact recorded token and runtime to that native ID/);
  assert.match(resume.reason, /Eligible nonAnalyst fresh\/resume paths retain existing admission using native prior evidence for resume/);
  assert.match(resume.reason, /Rejection does not upgrade, terminate or reconcile existing sessions/);
  assert.equal(preview.effectClass, "write");
  assert.match(preview.reason, /Source dry-runs remain static inspection and may produce private launch artifacts/);
  assert.match(preview.reason, /Actual Pi\/OPA adapters still reject protected execution even with mode dry-run/);
  assert.match(preview.reason, /not pure reads, execution admission or adoption/);
  assert.equal(rogue.effectClass, "launch"); assert.equal(rogue.targetDisposition, "operator-only");
  assert.match(rogue.reason, /Selecting rogue-one cannot reclassify a protected retained resume/);
  for (const row of interactionCatalogue) {
    assert.equal([...row.cliForms, ...row.nativeForms, ...row.aliases].some(form => /repository-isolation|scope-grant|pa_sandbox/.test(form)), false,
      "the interim checker adds no public executor, isolation selector or override form");
  }
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  // CLI auto-discovery does not cover imported checks, raw lineage/session
  // readers, runner lifecycle evidence or the two API admission boundaries.
  for (const path of ["packages/pa-core/src/deploy/repository-isolation.ts", "packages/pa-core/src/deploy/index.ts",
    "packages/pa-core/src/cli/commands/deploy.ts", "packages/pi-pa/src/deploy.ts", "packages/pi-pa/src/adapter.ts",
    "packages/opencode-pa/src/deploy.ts", "packages/opencode-pa/src/adapter.ts", "packages/pa-core/src/index.ts",
    "packages/pa-core/src/registry/index.ts", "packages/pa-core/src/registry/db.ts", "packages/pa-core/src/mode-capabilities.ts",
    "packages/pi-pa/src/session-owner.ts", "packages/opencode-pa/src/session-owner.ts",
    "packages/pi-pa/src/background-runner.ts", "packages/opencode-pa/src/background-runner.ts",
    "packages/pa-core/src/deploy/background-ownership.ts", "packages/pa-core/src/agent-api/index.ts",
    "packages/pa-core/src/agent-api/ws/session-hub.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked PAP-334 isolation check/export/ingress dependency: ${path}`);
  }
  const isolation = readFileSync(resolve(root, "packages/pa-core/src/deploy/repository-isolation.ts"), "utf8");
  assert.match(isolation, /queryReadonlyIsolationLineage\(deploymentId, runtime\)/);
  assert.match(isolation, /prior\.note\?\.startsWith\("requirements-document-"\) \|\| prior\.note\?\.startsWith\("readonly-document-policy\/"\)/);
  assert.match(isolation, /assertRepositoryIsolationBindingAvailable\(JSON\.parse\(prior\.binding\)\)/);
  assert.match(isolation, /const binding = parseModeCapabilityBinding\(value\)/);
  assert.match(isolation, /const environments = \[\.\.\.sources, plan\?\.environment\]/);
  assert.match(isolation, /requiresRepositoryIsolation\(selection\) && !\(selection\.instructionOnly === true/);
  assert.match(isolation, /queryReadonlyOrdinaryResume\(deploymentId\)/);
  assert.match(operation("deploy.launch").reason, /PAP-347 admits only resolved profile-free interactive analyst\/analyze through foreground Pi\/PPA/);
  assert.match(operation("deploy.launch").reason, /Instructions can fail: no sandbox or technical write-prevention guarantee/);
  assert.match(operation("deploy.resume").reason, /no retained binding, note or custody/);
  assert.match(isolation, /catch \{ throw new RepositoryIsolationUnavailableError\(\); \}/);
  assert.match(readFileSync(resolve(root, "packages/pa-core/src/deploy/index.ts"), "utf8"), /export \* from "\.\/repository-isolation\.js"/);
});

test("PAP-334 P2b API owner reasons keep provenance finite without advertising new commands or grants", () => {
  for (const id of ["deploy.resume", "serve.start", "serve.restart"]) {
    const row = operation(id);
    assert.match(row.reason, /before runtime preflight/);
    assert.match(row.reason, /before (?:session )?allocation/);
    assert.match(row.reason, /including default-command fallback/);
    assert.match(row.reason, /Stdout session hints never grant resume provenance/);
    assert.match(row.reason, /matching launch-bound native session argument with retained origin or an exact recorded managed session/);
    assert.match(row.reason, /Unknown opaque API resumes remain unavailable/);
    assert.match(row.reason, /(?:known launch-bound or recorded nonAnalyst API continuations remain admitted|known launch-bound\/recorded continuations retain existing admission)/);
    assert.deepEqual(row.channels, ["cli"]); assert.deepEqual(row.nativeForms, []);
    assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null);
    assert.equal(row.requestSchemaRef, null); assert.equal(row.resultSchemaRef, null);
  }
  for (const id of ["serve.start", "serve.restart"]) {
    const row = operation(id);
    assert.equal(row.effectClass, "resource"); assert.equal(row.targetDisposition, "operator-only");
    assert.match(row.reason, /no working confined executor, installed availability or universal route qualification/);
  }
  const hub = readFileSync(resolve(root, "packages/pa-core/src/agent-api/ws/session-hub.ts"), "utf8");
  assert.match(hub, /this\.assertExecutionAvailable\(opts\)/);
  assert.match(hub, /readRecordedRuntimeSession\(id, `session-id-\$\{runtime\}\.txt`\) !== opts\.sessionId/);
  assert.match(hub, /flagIndex === args\.lastIndexOf\(sessionFlag\) && args\[flagIndex \+ 1\] === nativeId/);
  assert.doesNotMatch(hub, /nativeSessionOrigins\.set\((?:nativeSessionId|session\.sessionIdParser)/,
    "stdout parser observations must not qualify native resume origin");
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
  // Both resource-bound versions suppress the independent mutable skill loader;
  // unbound/retained plans keep explicit skills. Background must do the same.
  assert.match(adapter, /if \(!hasModeResources\(plan\.modeCapabilityBinding\)\) \{\s*for \(const skill of plan\.skills\) args\.push\("--skill", skill\.path\);/);
  assert.match(adapter, /skills: hasModeResources\(plan\?\.modeCapabilityBinding\) \? \[\] : plan\?\.skills\.map\(\(skill\) => skill\.path\) \?\? \[\]/);
  const capabilities = readFileSync(resolve(root, "packages/pa-core/src/mode-capabilities.ts"), "utf8");
  assert.match(capabilities, /return binding\?\.schemaVersion === "pa-mode-capability-binding\/v2" \|\| binding\?\.schemaVersion === "pa-mode-capability-binding\/v3";/);
});

test("Rogue-One configured retention preserves the launch form, native exception and null native bindings", () => {
  const row = operation("deploy.rogue-one");
  assert.deepEqual(row.cliForms, ["deploy rogue-one"]);
  assert.deepEqual(row.channels, ["cli"]);
  assert.deepEqual(row.nativeForms, []);
  assert.equal(row.effectClass, "launch");
  assert.equal(row.targetDisposition, "operator-only");
  assert.equal(row.nativeBinding, null);
  assert.equal(row.delegationBinding, null);
  assert.equal(row.requestSchemaRef, null);
  assert.equal(row.resultSchemaRef, null);
  assert.match(row.reason, /Foreground PPA CLI uses selected PAPC interactive mode\/pair\/objective\/guides\/agents\/skills/);
  assert.match(row.reason, /does not add ordinary vacancy, Git-status, lease, workflow or final-review admission/);
  assert.match(row.reason, /preserve original resources and effective overrides on resume/);
  assert.match(row.reason, /without live-PAPC fallback/);
  assert.match(row.reason, /OPA, background, Agent API deployment and WebSocket Rogue-One execution are explicitly unsupported/);
  assert.match(row.reason, /operator API authentication still precedes rejection/);
  assert.match(row.reason, /adds no commands, aliases, native bindings, runtime permissions or approval authority/);
  assert.match(row.reason, /cannot reclassify a protected retained resume/);
});

test("conservative source inventory rejects tracked changes and added CLI command files pending semantic reconciliation", () => {
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  const commandDir = "packages/pa-core/src/cli/commands";
  const files = readdirSync(resolve(root, commandDir)).filter(name => name.endsWith(".ts")).map(name => `${commandDir}/${name}`);
  for (const path of files) assert.ok(Object.hasOwn(manifest.sources, path), `unreviewed command source: ${path}`);
  const changed = Object.entries(manifest.sources).filter(([path, sha256]) => createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex") !== sha256).map(([path]) => path);
  assert.deepEqual(changed, [], "Changed sources require operations/aliases/effect reconciliation before renewing exact hashes");
  for (const row of interactionCatalogue) assert.ok(Object.hasOwn(manifest.sources, row.sourceHandler.split("#")[0]!), `untracked handler ${row.sourceHandler}`);
  // A source guard is deliberately conservative, not a parser-based completeness proof.
  const baseline = readFileSync(resolve(root, "packages/pa-core/src/cli/core-command.ts"));
  const mutated = Buffer.concat([baseline, Buffer.from('\n// fixture: new unlisted dispatch\n')]);
  assert.notEqual(createHash("sha256").update(mutated).digest("hex"), manifest.sources["packages/pa-core/src/cli/core-command.ts"]);
});

test("PAP-349 dependency inventory survives release version bumps without ignoring dependency changes", () => {
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  // Version Bump owns these package versions. The lockfile already captures the
  // core production dependency selection without pinning mutable release bytes.
  for (const file of ["package.json", "packages/pa-core/package.json", "packages/opencode-pa/package.json", "packages/pi-pa/package.json"])
    assert.equal(Object.hasOwn(manifest.sources, file), false, `release version file must not invalidate source inventory: ${file}`);
  const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  assert.equal(createHash("sha256").update(lock).digest("hex"), manifest.sources["pnpm-lock.yaml"]);
  const core = JSON.parse(readFileSync(resolve(root, "packages/pa-core/package.json"), "utf8"));
  assert.equal(typeof core.dependencies.typescript, "string", "AST parser is a production dependency");
  assert.match(lock, /packages\/pa-core:[\s\S]*?\n      typescript:\n        specifier:/);
  assert.notEqual(createHash("sha256").update(`${lock}\n# synthetic dependency drift\n`).digest("hex"), manifest.sources["pnpm-lock.yaml"]);
});

test("PAP-337 startup split tracks the same read-only owner without changing forms, effects or native bindings", () => {
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  for (const path of ["packages/pi-pa/src/cli.ts", "packages/pi-pa/src/deploy.ts", "packages/pi-pa/src/readonly-helper.ts"]) {
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked CLI/helper owner: ${path}`);
  }
  // Lazy loading changes startup dependencies, not any operation's admission.
  // The conservative hash guard above still rejects all changed tracked bytes.
  for (const [id, forms] of [
    ["global.version", ["--version", "-V"]],
    ["board.list", ["board", "board --project", "board --all", "board --include-archived"]],
    ["branch.validate", ["branch validate"]],
    ["repository.inspect", ["repository inspect"]],
  ] as const) {
    const row = operation(id);
    assert.deepEqual(row.cliForms, forms);
    assert.deepEqual(row.channels, ["cli"]);
    assert.deepEqual(row.nativeForms, []);
    assert.equal(row.effectClass, "read");
    assert.equal(row.nativeBinding, null);
    assert.equal(row.delegationBinding, null);
  }
  for (const id of ["branch.create", "repository.quarantine"]) {
    const row = operation(id);
    assert.equal(row.effectClass, "resource");
    assert.equal(row.targetDisposition, "operator-only");
    assert.equal(row.nativeBinding, null);
  }
  assert.equal(operation("deploy.launch").effectClass, "launch");
  assert.equal(operation("deploy.launch").nativeBinding, null);
});

test("PAP-324 naming-policy reconciliation tracks pure matching and observation dependencies without adding effects", () => {
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  // Existing actions, aliases, request/result schemas and effect categories are
  // unchanged. Only registered naming-policy admission and read-only recovery
  // internals changed; renewing this snapshot grants no installed capability.
  for (const path of ["packages/pa-core/src/documents/handoff-policy.ts", "packages/pa-core/src/config.ts",
    "packages/pa-core/src/tickets/git-validation.ts", "packages/pi-pa/src/document-session.ts"])
    assert.ok(Object.hasOwn(manifest.sources, path), `untracked policy/observation dependency: ${path}`);
  assert.equal(operation("handoff.plan-status").effectClass, "read");
  for (const action of ["plan", "prepare-review", "review", "publish", "complete-branch", "queue"]) {
    const row = operation(`handoff.${action}`);
    assert.equal(row.effectClass, "write"); assert.equal(row.nativeBinding, null);
  }
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

test("PAP-336 boot module preserves operator-only serve effects and adds no CLI or native forms", () => {
  const manifest = JSON.parse(readFileSync(new URL("../interactions/source-inventory.json", import.meta.url), "utf8")) as { sources: Record<string, string> };
  assert.ok(Object.hasOwn(manifest.sources, "nix/pa-server.nix"), "track the boot service owner imported by flake.nix");
  const module = readFileSync(resolve(root, "nix/pa-server.nix"), "utf8");
  assert.match(module, /config = lib\.mkIf cfg\.enable/);
  assert.ok(module.includes('ExecStart = "${cfg.package}/bin/pa-core serve --host 127.0.0.1 --port ${toString cfg.port}";'));
  assert.doesNotMatch(module, /--background|--force|--cors|0\.0\.0\.0/);
  assert.deepEqual(operation("serve.start").cliForms, ["serve", "serve --background", "serve --force", "serve --dev", "serve --host", "serve --port", "serve --cors", "serve --local-review"]);
  for (const id of ["serve.start", "serve.stop", "serve.restart"]) {
    const row = operation(id);
    assert.equal(row.effectClass, "resource");
    assert.equal(row.targetDisposition, "operator-only");
    assert.deepEqual(row.nativeForms, []);
    assert.equal(row.nativeBinding, null);
    assert.equal(row.delegationBinding, null);
  }
  assert.equal(operation("serve.status").effectClass, "write", "stale PID cleanup is still not a native observational read");
});
