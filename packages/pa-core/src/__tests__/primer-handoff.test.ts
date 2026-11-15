import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTeamYamlContent } from "../yaml-parser.js";
import { generatePrimer } from "../primer/index.js";
import { digest } from "../workflows/contracts.js";

const fragment = "primers/fragments/shared/completion.md";
function fixture(profile = "pa-document-policy/v1") {
  const root = mkdtempSync(join(tmpdir(), "pa-handoff-primer-"));
  const bodies = {
    "objective.md": "Complete selected objective body.\nPreserve every objective paragraph.\n",
    "aid.md": "Complete selected writing aid body.\nAll aid details must survive composition.\n",
    "dispatch.md": "Complete selected dispatch body.\nNative owners retain every effect boundary.\n",
    [fragment]: "Complete selected completion body.\nReport approval, publication, branch, checkout, queue, launch and UAT separately.\nUse {{RUNTIME_ADAPTER}} only where selected; no new branch authority.\n",
  };
  for (const [path, body] of Object.entries(bodies)) {
    const full = join(root, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, body);
  }
  const skill = join(root, "skills", "pa-requirements-workflow"); mkdirSync(skill, { recursive: true });
  const process = "Complete selected process body.\nKeep every process paragraph, not just a token.\n";
  writeFileSync(join(skill, "SKILL.md"), process);
  const team = parseTeamYamlContent(`name: requirements\ndescription: Handoff composition fixture\nobjective: Fallback objective\nglobal_docs: [aid.md, dispatch.md]\nagents: []\ndeploy_modes:\n  - id: analyze\n    label: Analyze\n    document_profile: ${profile}\n${profile === "pa-document-policy/v1" ? "    capability_policy:\n      version: pa-mode-capabilities/v1\n      allow: [document.package, ordinary.read]\n" : ""}    objective: objective.md\n    skills:\n      - name: pa-requirements-workflow\n        inject-as: shared-skill\n`);
  const options = { runtime: "pi" as const, requirementsDocument: true, teamConfig: team, mode: "analyze", resolveFile: (path: string) => join(root, path), skillsDir: join(root, "skills") };
  return { root, bodies, process, options, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("fresh selected policy composes full process/aid/objective/dispatch/completion bodies and raw completion identity", () => {
  const f = fixture();
  try {
    const primer = generatePrimer(f.options);
    assert.ok(primer.includes(f.process));
    for (const body of Object.values(f.bodies)) assert.ok(primer.includes(body.replaceAll("{{RUNTIME_ADAPTER}}", "ppa")), body);
    assert.ok(primer.includes(`pa:selected-completion path=${fragment} sha256=${digest(f.bodies[fragment])}`));
    assert.doesNotMatch(primer, /no shell, generic source\/Git writers, builder preparation or resource operations are granted/);
    assert.match(primer, /ordinary bash\/read\/edit\/write may be used only when selected/);
    assert.match(primer, /Repository\/Git writing, builder preparation and resource operations are not granted/);
    assert.match(primer, /Do not use shell or generic writers for logging\/registry bookkeeping/);
  } finally { f.close(); }
});

test("completion composition uses the selected resolver and never falls back to current config on missing retained bytes", () => {
  const f = fixture();
  try {
    const options = { ...f.options, resolveFile: (path: string) => path === fragment ? undefined : join(f.root, path) };
    assert.throws(() => generatePrimer(options), (error: unknown) => {
      assert.ok(error instanceof Error); assert.ok(error.message.length <= 2000);
      for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(error.message.split(label).length, 2);
      return true;
    });
  } finally { f.close(); }
});

for (const profile of ["pa-document-package/v1", "pa-document-workspace/v2", "pa-document-confirmation/v3", "pa-document-interactions/v4"]) {
  test(`retained ${profile} never consumes the new policy completion projection`, () => {
    const f = fixture(profile);
    try {
      let completionReads = 0;
      const primer = generatePrimer({ ...f.options, resolveFile: path => { if (path === fragment) completionReads++; return join(f.root, path); } });
      assert.equal(completionReads, 0); assert.doesNotMatch(primer, /Complete selected completion body|pa:selected-completion/);
      assert.match(primer, /no shell, generic source\/Git writers, builder preparation or resource operations are granted/);
    } finally { f.close(); }
  });
}

test("OPA, workflow and omitted-document routes do not acquire policy completion or capability context", () => {
  const f = fixture();
  try {
    for (const options of [{ ...f.options, runtime: "opencode" as const }, { ...f.options, requirementsDocument: false },
      { ...f.options, workflow: { runId: "wf-fixture", workflowId: "fixture", version: "v1", sha256: "a".repeat(64), configRevision: "b".repeat(40), nextOwner: "none", nextAction: "inspect" } }]) {
      const primer = generatePrimer(options);
      assert.doesNotMatch(primer, /pa:selected-completion|Complete selected completion body/);
    }
  } finally { f.close(); }
});

test("oversized or invalid UTF-8 selected completion fails instead of truncating the canonical body", () => {
  const f = fixture();
  try {
    for (const value of [Buffer.alloc(65537, 65), Buffer.from([0xff])]) {
      writeFileSync(join(f.root, fragment), value); assert.throws(() => generatePrimer(f.options), /selected completion fragment is unavailable/);
    }
  } finally { f.close(); }
});
