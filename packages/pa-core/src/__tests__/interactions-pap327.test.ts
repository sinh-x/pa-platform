import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DOCUMENT_ACTION_FIELDS } from "../documents/package-contract.js";
import { parseContentReviewRequest } from "../documents/content-review-contract.js";
import { parseContentPublicationRequest } from "../documents/content-publication-contract.js";
import { interactionCatalogue, validateInteractionCatalogue } from "../interactions/catalogue.js";
import { INTERACTIONS_VERSION, SOURCE_ONLY_AVAILABILITY, parseCapabilityRequest, type InteractionEffect } from "../interactions/contract.js";
import { createSourceCatalogueReader } from "../interactions/discovery.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const operation = (id: string) => {
  const row = interactionCatalogue.find(entry => entry.operationId === id);
  assert.ok(row, `missing PAP-327 operation: ${id}`);
  return row;
};
// Explicit effect/transport closure, not a snapshot generated from the catalogue.
const review = [
  ["prepare", "write", ["pa_document:review-prepare"]],
  ["list", "read", ["pa_document:review-list", "/pa-review TICKET"]],
  ["show", "read", ["pa_document:review-show"]],
  ["review", "write", ["pa_document:review-sign", "/pa-review REFERENCE"]],
  ["request", "write", []],
  ["decide", "write", []],
] as const;
const publication = [
  ["authorize", "write", "content-publication-authorize"],
  ["status", "read", "content-publication-status"],
  ["publish", "write", "content-publish"],
  ["revoke", "write", "content-revoke"],
  ["supersede", "write", "content-supersede"],
] as const;
const otherEffects: readonly (readonly [string, InteractionEffect])[] = [
  ["document.review.list", "read"], ["document.review.show", "read"], ["document.review.sign", "write"],
  ["phase-report.attach-actual", "write"], ["phase-report.observe-actual", "write"],
  ["ticket.planned-actual", "read"], ["resource.selected.read", "read"],
];

test("PAP-327 finite content review and separate publication aliases have exact effect and native channel closure", () => {
  for (const [action, effect, aliases] of review) {
    const row = operation(`document.content-review.${action}`);
    assert.equal(row.effectClass, effect);
    assert.deepEqual(row.nativeForms, [`pa_handoff:pa-content-review/v1:${action}`, ...aliases]);
    assert.equal(row.sourceHandler, "packages/pi-pa/src/content-review-native.ts");
    assert.match(row.reason, /sign-content-only/);
    assert.match(row.reason, /no.*publication/i);
    assert.deepEqual(row.channels, ["native"]); assert.deepEqual(row.cliForms, []);
  }
  for (const [action, effect, alias] of publication) {
    const row = operation(`document.content-publication.${action}`);
    assert.equal(row.effectClass, effect);
    assert.deepEqual(row.nativeForms, [`pa_handoff:pa-content-publication/v1:${action}`, `pa_document:${alias}`]);
    assert.equal(row.sourceHandler, "packages/pi-pa/src/content-publication-native.ts");
    assert.match(row.reason, /separate.*authority/i);
    assert.deepEqual(row.channels, ["native"]); assert.deepEqual(row.cliForms, []);
  }
  // Every public document action, including the aliases above, has one owner.
  const forms = interactionCatalogue.flatMap(row => row.nativeForms);
  for (const action of Object.keys(DOCUMENT_ACTION_FIELDS)) {
    assert.equal(forms.filter(form => form === `pa_document:${action}`).length, 1, `unreconciled document action: ${action}`);
  }
  assert.match(operation("document.content-review.prepare").reason, /delivery.*persist/i);
  assert.match(operation("document.content-review.review").reason, /detach.*pending/i);
  assert.match(operation("document.content-publication.authorize").reason, /does not publish/i);
  assert.match(operation("document.content-publication.publish").reason, /readback.*primary/i);
  for (const action of ["revoke", "supersede"]) assert.match(operation(`document.content-publication.${action}`).reason, /fenc.*missing.*preserv.*completed/i);
});

test("PAP-327 guided review, report writes, ticket projection and immutable read are distinct finite variants", () => {
  for (const [id, effect] of otherEffects) assert.equal(operation(id).effectClass, effect);
  for (const [action, form] of [["list", "document review list TICKET"], ["show", "document review show REFERENCE"], ["sign", "document review REFERENCE"]]) {
    const row = operation(`document.review.${action}`);
    assert.deepEqual(row.cliForms, [form]); assert.deepEqual(row.nativeForms, []); assert.deepEqual(row.channels, ["cli"]);
    assert.match(row.requiredContext.join(" "), /no caller authentication/);
    assert.doesNotMatch(row.requiredContext.join(" "), /authenticated caller/);
  }
  for (const action of ["attach-actual", "observe-actual"]) {
    assert.deepEqual(operation(`phase-report.${action}`).nativeForms, [`pa_phase_report:${action}`]);
    assert.match(operation(`phase-report.${action}`).reason, /not.*acceptance/i);
  }
  assert.match(operation("phase-report.attach-actual").reason, /orch.*impl.*attachment/);
  assert.match(operation("phase-report.observe-actual").reason, /append.*local-unverified/i);
  assert.deepEqual(operation("ticket.planned-actual").nativeForms, ["pa_ticket:read:plannedActual", "pa_ticket:show:plannedActual", "pa_ticket:read:reference", "pa_ticket:show:reference", "pa_ticket:read:reference+candidate", "pa_ticket:show:reference+candidate", "pa_ticket:read:page", "pa_ticket:show:page"]);
  assert.match(operation("ticket.planned-actual").reason, /reference reads Planned without inventing a candidate/);
  assert.match(operation("ticket.planned-actual").reason, /snapshot-bound page continuation/);
  assert.match(operation("ticket.planned-actual").reason, /mismatch.*unmatched/i);
  const selected = operation("resource.selected.read");
  assert.deepEqual(selected.nativeForms, ["read:selected-resource:<selected path>"]);
  assert.deepEqual(selected.cliForms, []);
  assert.match(selected.reason, /existing.*selected.*read/i);
  assert.match(selected.reason, /no mutable.*fallback/i);
  assert.match(selected.reason, /reference-only/);
});

test("PAP-327 closure rejects deletion, class changes and source-binding promotion, including nominal reads", () => {
  const expected: readonly (readonly [string, InteractionEffect])[] = [
    ...review.map(([action, effect]) => [`document.content-review.${action}`, effect] as const),
    ...publication.map(([action, effect]) => [`document.content-publication.${action}`, effect] as const), ...otherEffects,
  ];
  for (const [id, effect] of expected) {
    const row = operation(id);
    assert.equal(row.targetDisposition, "native-supported");
    assert.equal(row.nativeBinding, null); assert.equal(row.delegationBinding, null);
    assert.equal(row.requestSchemaRef, null); assert.equal(row.resultSchemaRef, null);
    assert.ok(validateInteractionCatalogue(interactionCatalogue.filter(row => row.operationId !== id)).includes("missing-effect-variant"), id);
    const changed = (patch: Partial<typeof row>) => interactionCatalogue.map(row => row.operationId === id ? { ...row, ...patch } : row);
    assert.ok(validateInteractionCatalogue(changed({ effectClass: effect === "read" ? "write" : "read" })).includes("effect-regression"), id);
    assert.ok(validateInteractionCatalogue(changed({ nativeBinding: { tool: "invented", action: "execute" }, requestSchemaRef: "invented", resultSchemaRef: "invented" })).includes("source-binding-regression"), id);
  }
  // Retained effect owners and unauthenticated transports are not replaced.
  for (const id of ["document.native.confirm", "document.native.publish", "document.native.queue", "handoff.review", "handoff.publish", "handoff.complete-branch", "handoff.queue", "document.review.stdin"]) assert.equal(operation(id).effectClass, "write");
  assert.equal(operation("document.review.serve").effectClass, "resource");
  assert.deepEqual(operation("document.review.stdin").nativeForms, []);
});

test("PAP-327 source discovery filters separate reads from signing/effects without becoming an execution parser", () => {
  const reader = createSourceCatalogueReader();
  for (const [id, effect] of otherEffects) {
    const raw = JSON.stringify({ schemaVersion: INTERACTIONS_VERSION, action: "describe", operationId: id });
    const result = JSON.parse(reader(raw));
    assert.equal(result.operation.effectClass, effect); assert.deepEqual(result.availability, SOURCE_ONLY_AVAILABILITY);
    assert.equal(result.scope, "source-only"); assert.equal(result.operation.nativeBinding, null);
  }
  const result = JSON.parse(reader(JSON.stringify({ schemaVersion: INTERACTIONS_VERSION, action: "list", family: "document", effect: "read", limit: 100 })));
  assert.equal(result.page.complete, true);
  const ids: string[] = result.operations.map((row: { operationId: string }) => row.operationId);
  for (const id of ["document.content-review.list", "document.content-review.show", "document.content-publication.status"]) assert.ok(ids.includes(id));
  for (const id of ["document.content-review.prepare", "document.content-review.review", "document.content-review.request", "document.content-review.decide", ...publication.filter(([, effect]) => effect === "write").map(([action]) => `document.content-publication.${action}`)]) assert.equal(ids.includes(id), false);
  for (const action of ["review-sign", "authorize", "publish", "attach-actual", "read"]) assert.throws(() => parseCapabilityRequest(JSON.stringify({ schemaVersion: INTERACTIONS_VERSION, action, reference: `review:${"a".repeat(64)}` })));
  const reference = `review:${"a".repeat(64)}`;
  // New versioned owners do not reinterpret retained effects or import authority.
  for (const action of ["publish", "queue", "revoke", "complete-branch"]) assert.throws(() => parseContentReviewRequest(JSON.stringify({ schemaVersion: "pa-content-review/v1", action, reference })));
  for (const action of ["review", "decide", "queue", "complete-branch"]) assert.throws(() => parseContentPublicationRequest(JSON.stringify({ schemaVersion: "pa-content-publication/v1", action, reference })));
  for (const field of ["outcome", "authority", "actor", "root", "effects", "decisionId"]) assert.throws(() => parseContentPublicationRequest(JSON.stringify({ schemaVersion: "pa-content-publication/v1", action: "publish", reference, [field]: "untrusted" })));
});

test("PAP-327 inventory enumerates new finite owner modules and their non-dispatch dependencies", () => {
  // Repository fixture only, not unvalidated production input.
  const manifest = JSON.parse(readFileSync(resolve(root, "packages/pa-core/src/interactions/source-inventory.json"), "utf8")) as { sources: Record<string, string> };
  const sources = ["packages/pa-core/src/selected-mode-resources.ts", "packages/pa-core/src/tickets/planned-actual.ts", "packages/pa-core/src/artifacts/phase-report.ts", "packages/pi-pa/src/phase-report-native.ts", "packages/pi-pa/src/pi-extension/ticket-tool.ts"];
  for (const directory of ["packages/pa-core/src/documents", "packages/pi-pa/src", "packages/pi-pa/src/pi-extension"]) {
    sources.push(...readdirSync(resolve(root, directory)).filter(name => /^(?:content-(?:review|publication).*|selected-resource-read)\.ts$/.test(name)).map(name => `${directory}/${name}`));
  }
  for (const path of sources) assert.ok(Object.hasOwn(manifest.sources, path), `untracked PAP-327 owner/dependency: ${path}`);
});
