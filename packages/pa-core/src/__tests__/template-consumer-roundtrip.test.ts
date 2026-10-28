import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { templateService } from "../templates/service.js";
import { digest } from "../templates/schema.js";
import { parseReviewMatrix, parseReviewMatrixArtifact, parseReviewObjective } from "../validation/review-contract.js";
import { templateFixture } from "./template-fixture.js";
import { producerFixture } from "./template-producer-fixture.js";
import { parsePairSignoff, parseTaskHandoff } from "../tickets/producer-contract.js";

for (const kind of ["fresh", "amendment"] as const) {
  test(`versioned ${kind} handoff/pair producer round-trips actual baseline with synthetic separate human evidence`, () => {
    const f = producerFixture(kind); try {
      assert.equal(parseTaskHandoff(f.handoff.candidate as string).handoffType, kind);
      assert.equal(parsePairSignoff(f.pair.candidate as string).handoffType, kind);
      const before = { ticket: readFileSync(f.ticketPath), source: readFileSync(f.requirementPath), refs: f.git(["show-ref"]), status: f.git(["status", "--porcelain=v2", "--untracked-files=all"]) };
      for (const mode of ["analyze", "owner-directed"]) for (let i = 0; i < 20; i++) assert.deepEqual(templateService(f.request, { selection: f.selection, team: "requirements", mode }), f.pair);
      assert.equal(templateService({ ...f.request, action: "validate", candidate: f.pair.candidate }, { selection: f.selection }).ok, true);
      const baseline = f.resolveBaseline(); assert.equal(baseline.baseSha, f.bindings.baseSha);
      assert.equal(baseline.requirements.sha256, digest(readFileSync(f.requirementPath)));
      assert.deepEqual({ ticket: readFileSync(f.ticketPath), source: readFileSync(f.requirementPath), refs: f.git(["show-ref"]), status: f.git(["status", "--porcelain=v2", "--untracked-files=all"]) }, before);
      // Rendering alone supplies no approved source or authenticated author.
      const content = readFileSync(f.requirementPath, "utf8"); writeFileSync(f.requirementPath, content.replace("Status: Approved — synthetic fixture only", "Status: Draft"));
      assert.throws(f.resolveBaseline, /ORDINARY_BASELINE_/);
    } finally { f.dispose(); }
  });
  for (const variant of ["author", "ticket", "repository", "root", "branch", "base", "revision", "preview-path", "preview-hash", "uat-path", "uat-hash", "matrix-source", "matrix-hash", "duplicate", "negated", "conditional", "withdrawn", "changed-integration", "malformed-preview", "opposite-preview-base"] as const) test(`versioned ${kind} consumer rejects ${variant} before dependent effects`, () => {
    const f = producerFixture(kind); try {
      let content = f.record.comments[0]!.content;
      const change = (field: string, value: string) => { content = content.replace(new RegExp(`^${field}: .+$`, "m"), `${field}: ${value}`); };
      if (variant === "author") f.record.comments[0]!.author = "requirements/analyst";
      if (variant === "ticket") change("Ticket", "FIX-238");
      if (variant === "repository") change("Repository Key", "foreign");
      if (variant === "root") change("Repository Root", f.root);
      if (variant === "branch") change("Feature Branch", "feature/FIX-237-foreign");
      if (variant === "base") change("Base SHA", "f".repeat(40));
      if (variant === "revision") change("Review Revision", "r002");
      if (variant === "preview-path") change("Requirements Preview", "agent-teams/requirements/artifacts/reviews/FIX-238/r001/requirements.md");
      if (variant === "preview-hash") change("Requirements Raw SHA-256", "f".repeat(64));
      if (variant === "uat-path") change("UAT Preview", "agent-teams/requirements/artifacts/reviews/FIX-238/r001/uat-preview.md");
      if (variant === "uat-hash") change("UAT Raw SHA-256", "f".repeat(64));
      if (variant === "matrix-source") change("Matrix Source", "requirements:agent-teams/requirements/artifacts/foreign.md");
      if (variant === "matrix-hash") change("Matrix Authority SHA-256", "f".repeat(64));
      if (variant === "duplicate") content += `\nBase SHA: ${f.bindings.baseSha}`;
      if (variant === "negated") content += "\nI do not approve this pair.";
      if (variant === "conditional") content += "\nOnly if later review passes.";
      if (variant === "withdrawn") f.record.comments.push({ id: "c-20000102000000000", author: "sinh", content: "I withdraw this approval.", timestamp: "2000-01-02T00:00:00.000Z" });
      if (variant === "changed-integration") { writeFileSync(join(f.bindings.repositoryRoot, "README"), "changed integration"); f.git(["commit", "-qam", "advance synthetic integration"]); }
      if (variant === "malformed-preview" || variant === "opposite-preview-base") {
        const bytes = variant === "malformed-preview" ? Buffer.from([255]) : Buffer.from(f.preview.replace("> Handoff Type:", `> ${kind === "fresh" ? "Retained" : "Approved"} Base SHA: ${f.bindings.baseSha}\n> Handoff Type:`));
        writeFileSync(join(f.ai, f.bindings.requirementsPreviewPath), bytes); change("Requirements Raw SHA-256", digest(bytes));
      }
      f.record.comments[0]!.content = content; f.saveTicket();
      const before = { ticket: readFileSync(f.ticketPath), source: readFileSync(f.requirementPath), refs: f.git(["show-ref"]), status: f.git(["status", "--porcelain=v2", "--untracked-files=all"]) };
      let calls = 0;
      if (variant === "changed-integration" && kind === "amendment") assert.equal(f.resolveBaseline().baseSha, f.bindings.baseSha, "retained materialized base is not substituted");
      else if (variant === "changed-integration") assert.throws(f.resolveBaseline, /ORDINARY_BASELINE_CONFIG_MISMATCH/);
      else { assert.throws(() => f.resolveBaseline(() => { calls++; throw new Error("must reject before Git"); }), /ORDINARY_BASELINE_/); assert.equal(calls, 0); }
      assert.deepEqual({ ticket: readFileSync(f.ticketPath), source: readFileSync(f.requirementPath), refs: f.git(["show-ref"]), status: f.git(["status", "--porcelain=v2", "--untracked-files=all"]) }, before);
    } finally { f.dispose(); }
  });
}

test("JSON matrix/objective producers round-trip the actual protected-review consumers", () => {
  const f = templateFixture(); try {
    const objective = parseReviewObjective(readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.objective.json", import.meta.url)));
    const artifact = parseReviewMatrixArtifact(readFileSync(new URL("./fixtures/protected-review-v1/producer-node-pnpm.md", import.meta.url)), objective.matrixSource);
    for (const [id, payload] of [["review-matrix", artifact.matrix], ["review-objective", objective]] as const) {
      const entry = f.registry.entries.find((e) => e.id === id)!;
      const source = "{{payload}}";
      writeFileSync(join(f.root, entry.source.path), source); entry.source.sha256 = digest(source);
      entry.bindings = { payload: { type: "json", required: true } }; entry.capabilities.render = true; entry.capabilities.validate = true;
      const selection = f.save();
      const request = { action: "render", id, version: "1", bindings: { payload } };
      const result = templateService(request, { selection }); assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((result.producer as Record<string, unknown>).candidateSha256, digest(result.candidate as string));
      const parsed = id === "review-matrix" ? parseReviewMatrix(result.candidate as string) : parseReviewObjective(result.candidate as string);
      assert.deepEqual(parsed, payload);
      assert.equal(templateService({ ...request, action: "validate", candidate: result.candidate }, { selection }).ok, true);
      const invalid = { ...payload, schemaVersion: "unsupported" };
      assert.equal(templateService({ ...request, bindings: { payload: invalid } }, { selection }).ok, false);
    }
  } finally { f.dispose(); }
});
test("PAP-271 review-bundle uses the one selected registry and only a runtime-owned actual-consumer port", () => {
  const f = templateFixture(); try {
    const entry = structuredClone(f.registry.entries[0]!); entry.id = "review-bundle"; entry.source.path = "skills/templates/review-bundle.md";
    entry.source.sha256 = digest("{{bundle}}"); entry.bindings = { bundle: { type: "json", required: true } };
    entry.validation = { kind: "review-bundle", sections: [] }; f.registry.entries.push(entry);
    writeFileSync(join(f.root, entry.source.path), "{{bundle}}"); const selection = f.save();
    const request = { action: "render", id: "review-bundle", version: "1", bindings: { bundle: { schemaVersion: "pa-review-bundle/v1", fixture: "Synthetic port delegation only" } } };
    assert.equal(templateService(request, { selection }).code, "TEMPLATE_CONSUMER_REQUIRED");
    let calls = 0;
    // This spy proves port delegation only, not PAP-271 schema compatibility.
    const host = { selection, reviewBundleConsumer: { schemaVersion: "pa-review-bundle/v1" as const, validate: (raw: Uint8Array) => { calls++; assert.deepEqual(JSON.parse(Buffer.from(raw).toString()), request.bindings.bundle); } } };
    const result = templateService(request, host); assert.equal(result.ok, true); assert.equal(calls, 1);
    assert.equal((result.validation as Record<string, unknown>).authority, false);
    assert.equal((result.producer as Record<string, unknown>).consumerContract, "pa-review-bundle/v1");
    assert.equal((result.producer as Record<string, unknown>).registrySha256, selection.registrySha256);
    assert.equal(templateService({ ...request, reviewBundleConsumer: { schemaVersion: "pa-review-bundle/v1" } }, { selection }).ok, false, "request cannot register a consumer");
    assert.equal(templateService(request, { ...host, reviewBundleConsumer: { ...host.reviewBundleConsumer, validate: () => { throw new Error("SENTINEL"); } } }).ok, false);
    assert.ok(!JSON.stringify(templateService(request, { ...host, reviewBundleConsumer: { ...host.reviewBundleConsumer, validate: () => { throw new Error("SENTINEL"); } } })).includes("SENTINEL"));
  } finally { f.dispose(); }
});
test("enabling workflow producers cannot bypass their exact typed consumers", () => {
  const f = templateFixture(); try {
    for (const id of ["pair-signoff", "handoff-fresh", "handoff-amendment"]) {
      const entry = f.registry.entries.find((e) => e.id === id)!; entry.capabilities.render = true; entry.capabilities.validate = true;
      assert.equal(templateService({ action: "render", id, version: "1", bindings: { ticket: "FIX-1" } }, { selection: f.save() }).ok, false);
    }
  } finally { f.dispose(); }
});
