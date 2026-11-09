import assert from "node:assert/strict";
import { test } from "node:test";
import { DOCUMENT_PACKAGE_VERSION, documentDestination, documentPackageSha, parseDocumentPackage, parseDocumentRequest, type DocumentPackage } from "../documents/package-contract.js";

export function documentFixture(): DocumentPackage {
  return { schemaVersion: DOCUMENT_PACKAGE_VERSION, packageId: "example", revision: 1, repository: { key: "example", root: "/tmp/example" }, ticket: "EX-1", predecessor: null,
    members: (["brief", "requirements", "uat"] as const).map(role => ({ id: role, role, mediaType: "text/markdown", source: `agent-teams/requirements/artifacts/reviews/EX-1/r001/${role}.md`, description: role, bytes: 1, sha256: "a".repeat(64) })),
    references: [], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
}
test("document package has independent extensible semantics without branch, workflow or matrix", () => {
  const p = documentFixture(); p.members.push({ ...p.members[0]!, id: "mockup", role: "specification", source: "agent-teams/requirements/artifacts/drafts/mockup.png", mediaType: "image/png" });
  assert.deepEqual(parseDocumentPackage(p), p);
  assert.equal(documentDestination(p, p.members[3]!), "agent-teams/requirements/artifacts/packages/EX-1/example/r001/mockup.png");
  const hash = documentPackageSha(p); p.effects.queue = false; assert.notEqual(hash, documentPackageSha(p));
});
test("document contract rejects forged authority, unsafe identities, incomplete and aliased member sets", () => {
  for (const mutate of [
    (p: any) => p.approved = true,
    (p: any) => p.members.push(p.members[0]),
    (p: any) => p.members.pop(),
    (p: any) => p.members[0].source = "src/index.ts",
    (p: any) => p.members[0].source += "/../secret",
    (p: any) => p.members[0].mediaType = "image/svg+xml",
    (p: any) => p.members[0].bytes = 1_048_577,
    (p: any) => p.repository.root = "/tmp/../example",
    (p: any) => p.effects.route.mode = "implement",
    (p: any) => p.effects.source = true,
    (p: any) => p.schemaVersion = "pa-review-bundle/v1",
  ]) { const p = documentFixture(); mutate(p); assert.throws(() => parseDocumentPackage(p), /DOCUMENT_INPUT/); }
});
test("document raw request rejects duplicate keys and caller evidence", () => {
  for (const input of ['{"action":"check","action":"capture"}', '{"action":"capture","principal":"sinh"}', '{"action":"capture","outcome":"approved"}', '{"action":"check","passed":true}']) assert.throws(() => parseDocumentRequest(input), /DOCUMENT_INPUT/);
});
