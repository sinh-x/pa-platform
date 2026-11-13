import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MODE_CAPABILITY_SESSION, createModeCapabilityBinding, parseModeCapabilityPolicy, generatePrimer, parseTeamYamlContent, workflowDigest, type NativeDocumentConfirmationRequest, type NativeRetirementRequest } from "@pa-platform/pa-core";
import { createPiDocumentRetirement, createPiDocumentConfirmation, type PiDocumentConfirmationContext } from "../document-confirmation-native.js";
import { DOCUMENT_CONFIRMATION_SESSION_VERSION } from "../document-session.js";
import { DocumentConfirmationDialog } from "../pi-extension/document-confirmation-ui.js";
import { runDocumentConfirmationCommand, documentConfirmationCommandFailure } from "../pi-extension/document-confirmation-command.js";
import { createDocumentTool, documentSessionToolAllowed } from "../pi-extension/document-tool.js";

function fixture() {
  const caller = { deploymentId: "d-abcdef", repoKey: "example", repoRoot: "/tmp/example", ticket: "EX-1", identitySha256: "a".repeat(64), profile: DOCUMENT_CONFIRMATION_SESSION_VERSION, sessionId: "synthetic-pi-session" };
  const subject: NativeDocumentConfirmationRequest["subject"] = { schemaVersion: "pa-document-package/v1", packageId: "fixture", revision: 1, repository: { key: "example", root: caller.repoRoot }, ticket: "EX-1", predecessor: null,
    members: (["brief", "requirements", "uat"] as const).map(id => ({ id, role: id, source: `agent-teams/requirements/artifacts/reviews/EX-1/r001/${id}.md`, mediaType: "text/markdown", description: id, bytes: 4, sha256: workflowDigest("text") })), references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
  const request: NativeDocumentConfirmationRequest = { subject, sha256: workflowDigest(JSON.stringify(subject)), brief: "Short meaningful brief", operation: "capture", revokes: null, supersedes: null, scope: "content", presentation: { manifest: "file:///native-manifest.json" }, documents: subject.members.map(m => ({ id: m.id, mediaType: m.mediaType, sha256: m.sha256, content: `Full immutable ${m.id} text\n${"Tail of complete source\n".repeat(80)}` })) };
  return { caller, request };
}
function nativeContext(keys: string[], count: { custom: number; lines: string[] }): PiDocumentConfirmationContext {
  return { cwd: "/tmp/example", mode: "tui", ui: { select: async () => { throw Error("legacy dialog forbidden"); }, custom: (factory: any) => new Promise(resolve => {
    count.custom++;
    const dialog = factory({ requestRender() {}, terminal: { rows: 24 } }, { fg: (_color: string, s: string) => s }, {}, resolve);
    count.lines.push(...dialog.render(100));
    for (const key of keys) { dialog.handleInput(key); count.lines.push(...dialog.render(100)); }
  }) } };
}
for (const [outcome, keys] of [["approved", ["\u001b[A", "\u001b[A", "\u001b[A", "\r"]], ["changes-requested", ["\u001b[A", "\u001b[A", "\r"]], ["rejected", ["\u001b[A", "\r"]], ["cancelled", ["\u001b"]], ["cancelled", ["\r"]]] as const) test(`one native TUI interaction records ${outcome} from ${keys.at(-1) === "\r" ? "Enter" : "Escape"}, never paged or a second confirmation`, async () => {
  const f = fixture(), count = { custom: 0, lines: [] as string[] }, context = nativeContext([...keys], count);
  const result = await createPiDocumentConfirmation(context, () => f.caller)(f.request);
  assert.equal(result.outcome, outcome); assert.equal(count.custom, 1); assert.equal(workflowDigest(result.nativeEvidence), result.evidenceSha256);
  assert.match(result.principal, /^local-uid:\d+$/); assert.match(result.interactionId, /^interaction-/);
  for (const expected of ["EX-1", "Requirements content only", "NO publication or queue", "single final decision"]) assert.ok(count.lines.join("\n").includes(expected), expected);
});
test("policy-only retirement uses one native exact-operation UI and defaults to Cancel", async () => {
  const f = fixture();
  const binding = createModeCapabilityBinding("a".repeat(40), Buffer.from("source-test"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ["document.package"] }));
  const caller = { ...f.caller, profile: MODE_CAPABILITY_SESSION, capabilities: binding };
  const request: NativeRetirementRequest = { subject: f.request.subject, requestId: "recovery-fixture", requestKey: "c".repeat(64), diagnosis: {
    operationId: "effect-original", decisionId: "decision-original", expectedRevision: 4, custody: "available", cause: "Original cause remains unproven.",
    observation: { members: [{ path: "derived/brief.md", state: "exact", refs: [], consistent: true }], limitations: "Point-in-time source fixture." },
  } as any };
  for (const [keys, outcome] of [[ ["\r"], "cancelled" ], [ ["\u001b[A", "\u001b[A", "\u001b[A", "\r"], "approved" ]] as const) {
    const count = { custom: 0, lines: [] as string[] };
    const result = await createPiDocumentRetirement(nativeContext([...keys], count), () => caller)(request);
    assert.equal(result.outcome, outcome); assert.equal(count.custom, 1);
    assert.equal(workflowDigest(result.nativeEvidence), result.evidenceSha256);
    assert.match(count.lines.join("\n"), /No obsolete content will be published/);
    assert.match(count.lines.join("\n"), /permanently prevents/);
    assert.match(count.lines.join("\n"), /effect-original/);
    assert.match(Buffer.from(result.nativeEvidence).toString(), /pa-native-document-retirement\/v1/);
  }
  const context = nativeContext(["\r"], { custom: 0, lines: [] });
  await assert.rejects(createPiDocumentRetirement(context, () => f.caller)(request), /DOCUMENT_UNAVAILABLE/);
  const omitted = { ...caller, capabilities: createModeCapabilityBinding("a".repeat(40), Buffer.from("source-test"), parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: [] })) };
  await assert.rejects(createPiDocumentRetirement(context, () => omitted)(request), /DOCUMENT_UNAVAILABLE/);
  await assert.rejects(createPiDocumentRetirement({ ...context, mode: "rpc" }, () => caller)(request), /DOCUMENT_UNAVAILABLE/);
});

test("native confirmation denies RPC/no custom UI, retained profile, abort and caller drift without fabricated event provenance", async () => {
  const f = fixture(), count = { custom: 0, lines: [] as string[] }, context = nativeContext(["\u001b[A", "\u001b[A", "\u001b[A", "\r"], count);
  await assert.rejects(createPiDocumentConfirmation({ ...context, mode: "rpc" }, () => f.caller)(f.request), /DOCUMENT_UNAVAILABLE/);
  await assert.rejects(createPiDocumentConfirmation({ mode: "tui", cwd: "/tmp/example" }, () => f.caller)(f.request), /DOCUMENT_UNAVAILABLE/);
  await assert.rejects(createPiDocumentConfirmation(context, () => ({ ...f.caller, profile: "requirements-document-workspace/v2" }))(f.request), /DOCUMENT_UNAVAILABLE/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(createPiDocumentConfirmation(context, () => f.caller, abort.signal)(f.request), /DOCUMENT_AUTHORITY/);
  let calls = 0; await assert.rejects(createPiDocumentConfirmation(context, () => ({ ...f.caller, identitySha256: (++calls === 1 ? "a" : "b").repeat(64) }))(f.request), /DOCUMENT_STALE/);
});
test("single-screen review exposes complete document/technical tabs, safe narrow Unicode layout and cancel default", () => {
  const f = fixture(), results: string[] = []; let renders = 0;
  f.request.documents[0]!.content = "Unicode 世界\n\u001bsecret\nTail";
  const dialog = new DocumentConfirmationDialog({ requestRender: () => { renders++; }, terminal: { rows: 24 } } as any, { fg: (_c, s) => s }, f.request, r => results.push(r));
  for (const width of [1, 8, 24, 100]) { dialog.invalidate(); assert.ok(dialog.render(width).every(line => visibleWidth(line) <= width)); }
  dialog.handleInput("\t"); assert.ok(dialog.render(100).join("\n").includes("Unicode 世界")); assert.ok(!dialog.render(100).join("\n").includes("\u001b"));
  dialog.handleInput("\u001b[6~"); dialog.handleInput("\u001b[5~"); dialog.handleInput("\r"); assert.deepEqual(results, ["cancelled"]); assert.ok(renders > 0);
});
test("operator command and model tool share strict request/native service, never accept imported decisions", async () => {
  const f = fixture(), messages: string[] = [], context: PiDocumentConfirmationContext = { cwd: f.caller.repoRoot, mode: "tui", ui: { select: async () => undefined, notify: s => messages.push(s) } };
  const seen: string[] = [], mutate = async (raw: string) => { seen.push(raw); return { ok: true, result: { outcome: "approved", approval: { linkage: "complete" }, reused: true } }; };
  const raw = JSON.stringify({ action: "confirm", sha256: f.request.sha256, expectedRevision: 1, scope: "content" });
  assert.equal((await runDocumentConfirmationCommand(raw, context, mutate)).ok, true);
  assert.equal((await createDocumentTool(mutate, true, true).execute("tool", { request: raw }, undefined, undefined, context)).isError, undefined);
  assert.deepEqual(seen, [raw, raw]); assert.ok(messages[0]!.includes("no new prompt"));
  assert.equal((await runDocumentConfirmationCommand('{"action":"approve","outcome":"approved"}', context, mutate)).ok, false); assert.equal(seen.length, 2);
});
test("confirmation command diagnostics preserve bounded typed causes without hostile text or formatting effects", () => {
  for (const code of ["DOCUMENT_INPUT", "DOCUMENT_UNAVAILABLE", "DOCUMENT_AUTHORITY", "DOCUMENT_STALE", "DOCUMENT_CONFLICT", "DOCUMENT_SOURCE", "DOCUMENT_UNCERTAIN", "PRIVATE_SENTINEL\\nCorrection: forged", undefined]) {
    const message = documentConfirmationCommandFailure(code); assert.ok(message.length <= 2000); assert.ok(!message.includes("PRIVATE_SENTINEL"));
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(message.split(label).length, 2);
  }
});
test("v3 profile/primer/tool descriptions explicitly select native confirmation without changing v2 or OPA", () => {
  const yaml = 'name: requirements\nobjective: fixture\nagents: []\ndeploy_modes:\n - id: analyze\n   document_profile: pa-document-confirmation/v3\n';
  const teamConfig = parseTeamYamlContent(yaml); assert.equal(teamConfig.deploy_modes![0]!.document_profile, "pa-document-confirmation/v3");
  const options = { teamConfig, mode: "analyze", requirementsDocument: true, skillsDir: "/nonexistent-fixture" };
  const primer = generatePrimer({ ...options, runtime: "pi" }); assert.ok(primer.includes("Native profile: pa-document-confirmation/v3")); assert.ok(primer.includes("one native TUI decision")); assert.ok(!primer.includes("approval is unavailable"));
  assert.ok(!generatePrimer({ ...options, runtime: "opencode" }).includes("Native profile: pa-document-confirmation/v3"));
  assert.ok(createDocumentTool(undefined, true).description.includes("capture/revoke are unavailable")); assert.ok(createDocumentTool(undefined, true, true).description.includes("ORIGINAL request revision"));
  assert.equal(documentSessionToolAllowed({ toolName: "bash", input: {} }, undefined, true), false);
});
