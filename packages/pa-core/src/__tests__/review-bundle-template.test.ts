import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCoreCommand } from "../cli/core-command.js";
import { templateService } from "../templates/service.js";
import { parseReviewBundle } from "../workflows/contracts.js";
import { reviewBundleTemplateConsumer } from "../workflows/producer.js";
import { reviewBundleFixture } from "./review-bundle-template-fixture.js";

for (const kind of ["fresh", "amendment"] as const) for (const ticket of ["FIX-70", "FIX-070", "PAPC-070", "A-0"]) test(`default CLI ${kind} review-bundle preserves exact ${ticket} without workflow authority`, async () => {
  const f = reviewBundleFixture(kind, ticket);
  try {
    assert.deepEqual(parseReviewBundle(Buffer.from(JSON.stringify(f.bundle))), f.bundle);
    const host = { selection: f.selection, reviewBundleConsumer: reviewBundleTemplateConsumer };
    // The pure core seam still requires its actual parser; requests cannot
    // register callbacks or turn a producer receipt into workflow authority.
    assert.equal(templateService(f.request, { selection: f.selection }).code, "TEMPLATE_CONSUMER_REQUIRED");
    const expected = templateService(f.request, host); assert.equal(expected.ok, true);
    assert.deepEqual(expected.validation, { structural: true, consumer: true, authority: false }); assert.equal(expected.unsigned, true);
    const before = [readFileSync(join(f.root, "contracts/templates-v1.json")), readFileSync(join(f.root, "skills/templates/review-bundle.md"))];
    for (const action of ["render", "validate"]) for (let n = 0; n < 20; n++) {
      const body = { bindings: { bundle: f.bundle }, ...(action === "validate" ? { candidate: expected.candidate } : {}) };
      const input = { ...f.request, action, ...body }, canonical = templateService(input, host), output: string[] = [];
      assert.equal(await runCoreCommand(["template", action, "review-bundle", "--version", "r001"], { binaryName: "ppa", templateHost: { selection: f.selection, input: (async function* () { yield JSON.stringify(body); })() }, io: { stdout: s => output.push(s), stderr: s => assert.fail(s) } }), 0);
      assert.deepEqual(JSON.parse(output.join("")), JSON.parse(JSON.stringify(canonical)));
      assert.deepEqual(parseReviewBundle(Buffer.from(canonical.candidate as string)), f.bundle);
    }
    assert.deepEqual([readFileSync(join(f.root, "contracts/templates-v1.json")), readFileSync(join(f.root, "skills/templates/review-bundle.md"))], before);
  } finally { f.dispose(); }
});

test("actual shared review-bundle parser rejects mismatched aliases, fields, paths, controls and permission claims", () => {
  const f = reviewBundleFixture();
  try {
    const mutations: Array<(b: any) => void> = [
      b => { b.ticket = "FIX-70"; }, b => { b.handoff.branch = "feature/FIX-70-fixture"; },
      b => { b.ticket = `FIX-${"0".repeat(64)}`; }, b => { b.ticket = "fix-070"; },
      b => { b.handoff.baseSha = "B".repeat(40); }, b => { b.handoff.featureSha = "c".repeat(40); },
      b => { b.handoff.branchAction = "reuse"; }, b => { b.approved = true; }, b => { b.author = "sinh"; },
      b => { b.requestedPermissions.push("remote.push"); }, b => { b.requestedPermissions.push(b.requestedPermissions[0]); },
      b => { b.scope.files = ["../escape"]; }, b => { b.scope.files = [".git/config"]; },
      b => { b.repository.root = "/fixture/../canonical"; }, b => { b.repository.root += "\u200bSECRET-SENTINEL"; },
      b => { b.requirements.ref += "\u200bSECRET-SENTINEL"; }, b => { b.scope.files = ["src/\u200bSECRET-SENTINEL.ts"]; },
      b => { b.matrix.ref = b.uat.ref; }, b => { b.scope.checks[0].matrixSha256 = "f".repeat(64); },
      b => { b.scope.checks.push(b.scope.checks[0]); }, b => { b.requirements.version = "SECRET-SENTINEL\nforged"; },
    ];
    for (const mutate of mutations) {
      const bundle = structuredClone(f.bundle); mutate(bundle);
      assert.throws(() => parseReviewBundle(Buffer.from(JSON.stringify(bundle))));
      const result = templateService({ ...f.request, bindings: { bundle } }, { selection: f.selection, reviewBundleConsumer: reviewBundleTemplateConsumer });
      assert.equal(result.ok, false); assert.equal(result.unsigned, true);
      assert.ok((result.diagnostic as string).length <= 2000); assert.ok(!JSON.stringify(result).includes("SECRET-SENTINEL"));
    }
    for (const raw of ['{"ticket":"FIX-070","\\u0074icket":"SECRET-SENTINEL"}', '\ufeff{}', '{"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}']) assert.throws(() => parseReviewBundle(Buffer.from(raw)));
  } finally { f.dispose(); }
});
