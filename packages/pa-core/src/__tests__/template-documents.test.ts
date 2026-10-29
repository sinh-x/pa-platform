import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_PROFILES } from "../templates/document-profiles.js";
import { digest, type TemplateId } from "../templates/schema.js";
import { templateService } from "../templates/service.js";
import { templateFixture } from "./template-fixture.js";

for (const id of Object.keys(DOCUMENT_PROFILES) as TemplateId[]) test(`${id} enforces every selected section and required metadata without certifying facts`, () => {
  const f = templateFixture(); try {
    const entry = f.registry.entries.find(e => e.id === id)!, path = join(f.root, entry.source.path), original = readFileSync(path, "utf8");
    const request = { action: "render", id, version: "1", bindings: { ticket: "FIX-1" } };
    assert.equal(templateService(request, { selection: f.selection }).ok, true);
    for (const heading of entry.validation.sections) {
      for (const mutated of [original.replace(heading, "## Missing section"), original + `\r\n${heading}\r\nDuplicate section.\r\n`, original.replace(heading, `\`\`\`markdown\r\n${heading}\r\n\`\`\``)]) {
        writeFileSync(path, mutated); entry.source.sha256 = digest(mutated);
        assert.equal(templateService(request, { selection: f.save() }).ok, false, `missing/duplicate/fenced ${heading}`);
      }
    }
    for (const label of DOCUMENT_PROFILES[id]!.headers) {
      const mutated = original.replace(new RegExp(`^> ${label}: .+\\r?\\n`, "m"), ""); writeFileSync(path, mutated); entry.source.sha256 = digest(mutated);
      assert.equal(templateService(request, { selection: f.save() }).ok, false, `missing ${label}`);
    }
  } finally { f.dispose(); }
});
for (const [id, from, to] of [
  ["requirements", "FR-1", "FR-missing"], ["requirements", "AC-1:", "AC-missing:"], ["requirements", "Class: software-dev", "Class: arbitrary"],
  ["requirements", "Route: builder/orchestrator", "Route: requirements/analyze"], ["requirements", "Approved Base SHA: " + "a".repeat(40), "Approved Base SHA: " + "b".repeat(40)],
  ["requirements", '"branch": "feature/FIX-1-fixture"', '"branch": "feature/FIX-1-foreign"'],
  ["builder-objective", "Execution Model: direct-phase", "Execution Model: retired-child"],
  ["implementation-phase-report", "| 1 | synthetic only | unknown | Not run | none |", "| 1 | synthetic only |"],
  ["uat-plan", '- Acceptance Criterion: AC-1', '- Acceptance Criterion: AC-2'],
  ["uat-plan", 'Acceptance Criteria: ["AC-1"]', 'Acceptance Criteria: ["AC-1","AC-2"]'],
  ["uat-plan", "- Status: Not run.", "- Status: Passed."], ["uat-review", "- Actual Result: Not run.", "- Actual Result: Passed."],
  ["spike-learning-note", "status: draft", "status: reviewed"], ["spike-learning-note", "type: spike-research", "type: spike-research\r\ntype: forged"],
  ["spike-learning-note", "source_repo: fixture", "source_repo: &secret fixture\r\nrelated: *secret"],
] as const) test(`${id} rejects malformed trace/shape ${from}`, () => {
  const f = templateFixture(); try {
    const e = f.registry.entries.find(e => e.id === id)!, path = join(f.root, e.source.path), original = readFileSync(path, "utf8");
    assert.ok(original.includes(from)); const body = original.replace(from, to); writeFileSync(path, body); e.source.sha256 = digest(body);
    const r = templateService({ action: "render", id, version: "1", bindings: { ticket: "FIX-1" } }, { selection: f.save() }); assert.equal(r.ok, false);
  } finally { f.dispose(); }
});
