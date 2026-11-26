import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RogueOneConfig, RogueOneConfigError, selectRogueOneMode, type RogueOneConfigContext } from "../deploy/rogue-one-config.js";
import { appendRegistryEvent, closeDb } from "../registry/index.js";
import { getDeployPaths } from "../deploy/paths.js";
import { parseTeamYamlContent } from "../yaml-parser.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";

const yaml = `name: rogue-one\ndescription: Original team\nobjective: Original objective\nagents:\n  - name: selected\n    role: Original role\n    instruction: teams/selected.md\n  - name: unselected\n    role: Unselected\n    instruction: teams/missing.md\ndefault_mode: direct\nglobal_docs: [docs/global.md]\ndeploy_modes:\n  - id: direct\n    label: Direct\n    mode_type: interactive\n    objective: docs/objective.md\n    agents: [selected]\n    provider: openai\n    model: openai/gpt-6.2-sol\n    skills: [{name: example, inject-as: reference}]\n    project_guides:\n      fixture: [docs/repository.md]\n      foreign: [docs/foreign-missing.md]\n`;
const pair = { provider: "openai-codex", model: "gpt-6.2-sol", source: "mode" as const };
function fixture(run: (f: { root: string; config: string; context: RogueOneConfigContext; file: (relative: string, content: string) => void; capture: () => RogueOneConfig; start: (config: RogueOneConfig, id?: string) => void }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rogue-config-")), config = join(root, "config"), old = { ...process.env };
  process.env.PA_PLATFORM_HOME = config; process.env.PA_PLATFORM_CONFIG = join(root, "user"); process.env.PA_AI_USAGE_HOME = join(root, "ai");
  process.env.PA_PLATFORM_DATA = join(root, "data"); process.env.PA_REGISTRY_DB = join(root, "registry.db"); delete process.env.PA_PLATFORM_TEAMS; delete process.env.PA_PLATFORM_SKILLS;
  closeDb();
  const file = (relative: string, content: string) => { const at = join(config, relative); mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, content); };
  file("teams/rogue-one.yaml", yaml); file("teams/selected.md", "Selected original agent");
  file("docs/global.md", "[Support](support.md)\n`docs/absent.md`\n"); file("docs/support.md", "Original support\n[Deep](deep.md)"); file("docs/deep.md", "Original deep dependency");
  file("docs/objective.md", "Original mode objective"); file("docs/repository.md", "Original repository guide");
  file("skills/global/example/SKILL.md", "Original skill\n[Reference](reference.md)"); file("skills/global/example/reference.md", "Original skill support");
  const context: RogueOneConfigContext = { deploymentId: "d-349aaa", runtime: "pi", repoKey: "fixture", repoRoot: "/fixture/repo", worktreeRoot: "/fixture/worktree", ticket: "EX-1" };
  const capture = () => RogueOneConfig.capture(context, { team: "rogue-one", objective: "Original user objective" }, parseTeamYamlContent(readFileSync(join(config, "teams/rogue-one.yaml"), "utf8")), pair);
  const start = (captured: RogueOneConfig, id = context.deploymentId) => {
    mkdirSync(getDeployPaths(id).deployDir, { recursive: true, mode: 0o700 }); captured.materialize(id);
    writeFileSync(join(getDeployPaths(id).deployDir, "session-id-pi.txt"), "original-session", { mode: 0o600 });
    appendRegistryEvent({ deployment_id: id, event: "started", timestamp: new Date().toISOString(), team: "rogue-one", mode: "direct", rogue_one: true, runtime: "pi", binary: "ppa", invocation_channel: "cli", repo: context.worktreeRoot, repo_root: context.repoRoot, worktree_root: context.worktreeRoot, ticket_id: context.ticket, provider: pair.provider, models: { team: pair.model }, note: captured.note });
  };
  try { run({ root, config, context, file, capture, start }); }
  finally { closeDb(); process.env = old; rmSync(root, { recursive: true, force: true }); }
}
const rejected = (run: () => unknown, cause?: string) => assert.throws(run, error => error instanceof RogueOneConfigError && (!cause || error.cause === cause));

test("P1 captures working bytes, selected transitive closure and all effective overrides, without selecting foreign resources", () => fixture(f => {
  const captured = f.capture();
  assert.equal(captured.mode.id, "direct"); assert.deepEqual(captured.runtimeConfig, pair);
  assert.match(captured.read("docs/deep.md"), /Original deep/); assert.match(captured.read("skills/global/example/reference.md"), /Original skill support/);
  rejected(() => captured.read("teams/missing.md")); rejected(() => captured.read("docs/foreign-missing.md"));
  const request = captured.continuation({ team: "rogue-one", resume: f.context.deploymentId });
  assert.equal(request.objective, "Original user objective"); assert.equal(request.mode, "direct");
}));

test("P1 native resume retains A after deletion of all live PAPC; subsequent continuation binds a distinct native start", () => fixture(f => {
  const captured = f.capture(); f.start(captured);
  rmSync(f.config, { recursive: true });
  const retained = RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context);
  assert.equal(retained.team.description, "Original team"); assert.equal(retained.read("docs/deep.md"), "Original deep dependency");
  const next = retained.forDeployment("d-349bbb"); f.start(next, "d-349bbb");
  assert.notEqual(next.note, retained.note);
  assert.equal(RogueOneConfig.resume("d-349bbb", { team: "rogue-one" }, f.context).read("docs/deep.md"), "Original deep dependency");
  retained.assertCurrent();
}));

test("P1 source drift rejects after capture, including a previously absent dependency becoming present", () => fixture(f => {
  const captured = f.capture(); f.file("docs/absent.md", "Now present"); rejected(() => captured.assertCurrent(), "drift");
  rmSync(join(f.config, "docs/absent.md"));
  const next = f.capture(); f.file("docs/deep.md", "Changed"); rejected(() => next.assertCurrent(), "drift");
}));

test("P1 changed configuration affects fresh B, never native retained A", () => fixture(f => {
  const original = f.capture(); f.start(original);
  f.file("teams/rogue-one.yaml", yaml.replace("Original team", "Fresh B")); f.file("docs/deep.md", "Fresh B dependency");
  assert.equal(f.capture().team.description, "Fresh B");
  const retained = RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context);
  assert.equal(retained.team.description, "Original team"); assert.equal(retained.read("docs/deep.md"), "Original deep dependency");
}));

test("P1 archive tamper, partial writes and projection tamper reject without overwriting evidence", () => fixture(f => {
  const captured = f.capture(); f.start(captured);
  const projection = join(getDeployPaths(f.context.deploymentId).deployDir, "rogue-one-config/docs/deep.md");
  chmodSync(projection, 0o600); writeFileSync(projection, "Tampered");
  rejected(() => captured.materialize(f.context.deploymentId), "snapshot"); assert.equal(readFileSync(projection, "utf8"), "Tampered");
  const archive = join(getDeployPaths(f.context.deploymentId).deployDir, "rogue-one-config.json"); chmodSync(archive, 0o600); writeFileSync(archive, "{partial"); chmodSync(archive, 0o400);
  rejected(() => RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context), "snapshot"); assert.equal(readFileSync(archive, "utf8"), "{partial");
}));

test("P1 wrong native coordinates and conflicting continuation overrides reject", () => fixture(f => {
  f.start(f.capture());
  for (const patch of [{ runtime: "opencode" as const }, { repoRoot: "/other" }, { worktreeRoot: "/other" }, { ticket: "EX-2" }, { repoKey: "other" }])
    rejected(() => RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, { ...f.context, ...patch }));
  for (const patch of [{ mode: "other" }, { model: "gpt-other" }, { objective: "Other" }, { provider: "other" }, { timeout: 90 }])
    rejected(() => RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one", ...patch }, f.context), "conflict");
}));

test("P1 unanchored and legacy sessions are not upgraded using current PAPC", () => fixture(f => {
  const captured = f.capture(); mkdirSync(getDeployPaths(f.context.deploymentId).deployDir, { recursive: true, mode: 0o700 }); captured.materialize(f.context.deploymentId);
  writeFileSync(join(getDeployPaths(f.context.deploymentId).deployDir, "session-id-pi.txt"), "legacy-session", { mode: 0o600 });
  appendRegistryEvent({ deployment_id: f.context.deploymentId, team: "rogue-one", mode: "rogue-one", rogue_one: true, event: "started", timestamp: new Date().toISOString(), runtime: "pi" });
  rejected(() => RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context), "legacy");
  rejected(() => RogueOneConfig.resume("d-349ccc", { team: "rogue-one" }, f.context));
}));

test("P1 missing, unresolved, aliased and oversized dependencies fail closed", () => fixture(f => {
  const deep = join(f.config, "docs/deep.md"); rmSync(deep); rejected(f.capture);
  f.file("docs/deep.md", "[Script](../scripts/run.js)"); f.file("scripts/run.js", "import './dynamic.js'"); rejected(f.capture, "resource");
  f.file("docs/global.md", "Run `node scripts/run.js report.html`."); rejected(f.capture, "resource");
  f.file("docs/global.md", "[Support](support.md)");
  rmSync(deep); symlinkSync(join(f.config, "docs/repository.md"), deep); rejected(f.capture);
  rmSync(deep); f.file("docs/deep.md", "x".repeat(1_048_577)); rejected(f.capture);
}));

test("P1 capture disagreement with actual consumed team bytes rejects rather than mixing selections", () => fixture(f => {
  const selected = parseTeamYamlContent(yaml); f.file("teams/rogue-one.yaml", yaml.replace("Original team", "Changed"));
  rejected(() => RogueOneConfig.capture(f.context, { team: "rogue-one" }, selected, pair), "drift");
}));

test("P1 profile-free interactive contract rejects native authority requests and ambiguous selectors", () => {
  const team = parseTeamYamlContent(yaml);
  for (const patch of [{ require_ticket: true }, { mode_type: "work" as const }, { document_profile: "pa-document-policy/v1" as const }, { capability_policy: {} }]) {
    const altered = { ...team, deploy_modes: [{ ...team.deploy_modes![0]!, ...patch }] };
    rejected(() => selectRogueOneMode(altered as typeof team), "contract");
  }
  rejected(() => selectRogueOneMode(team, "missing"), "selection");
  rejected(() => selectRogueOneMode({ ...team, deploy_modes: [...team.deploy_modes!, ...team.deploy_modes!] }), "selection");
  rejected(() => selectRogueOneMode({ ...team, default_mode: undefined }), "selection");
  rejected(() => selectRogueOneMode({ ...team, name: "rogue-one-near" }), "selection");
});

test("P1 static HTML support is retained; active HTML dependencies fail closed", () => fixture(f => {
  f.file("docs/deep.md", "[Template](template.html)"); f.file("docs/template.html", '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><a href="support.md">Guide</a></body></html>');
  const captured = f.capture(); assert.match(captured.read("docs/template.html"), /Fixture/);
  f.file("docs/template.html", '<script src="dynamic.js"></script>'); rejected(f.capture, "resource");
}));

test("P1 changed native session is rejected on a continuation recheck", () => fixture(f => {
  f.start(f.capture()); const retained = RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context);
  writeFileSync(join(getDeployPaths(f.context.deploymentId).deployDir, "session-id-pi.txt"), "different-session");
  rejected(() => retained.assertCurrent(), "snapshot");
}));

test("retention captures active script imports and const-array file URL dependencies without activating reference-only examples", () => fixture(f => {
  f.file("docs/global.md", "Run `node scripts/check.mjs report.html`. [Reference only](example.md)");
  f.file("docs/example.md", "An illustrative source check is `node scripts/not-selected.mjs`.");
  f.file("scripts/not-selected.mjs", "import(process.argv[2]);");
  f.file("scripts/check.mjs", 'import { templates } from "./data.mjs"; import { readFileSync } from "node:fs"; readFileSync(new URL(`../${templates[0]}`,import.meta.url));');
  f.file("scripts/data.mjs", 'export const templates=["docs/first.txt","docs/second.txt"];');
  f.file("docs/first.txt", "Original first support"); f.file("docs/second.txt", "Original second support");
  const captured = f.capture(); f.start(captured);
  assert.equal(captured.read("docs/first.txt"), "Original first support");
  assert.equal(captured.read("docs/second.txt"), "Original second support");
  assert.match(captured.read("docs/example.md"), /illustrative source check/);
  rejected(() => captured.read("scripts/not-selected.mjs"));
  rmSync(f.config, { recursive: true });
  const retained = RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context);
  assert.deepEqual(retained.resources, captured.resources); assert.match(retained.read("scripts/check.mjs"), /templates/);
}));

test("native archives retain more than 1 MiB without relaxing per-resource limits or Review defaults", () => fixture(f => {
  f.file("docs/support.md", "a".repeat(650_000)); f.file("docs/repository.md", "b".repeat(650_000));
  const captured = f.capture(); f.start(captured); rmSync(f.config, { recursive: true });
  const retained = RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context);
  assert.equal(retained.read("docs/support.md").length, 650_000); assert.equal(retained.read("docs/repository.md").length, 650_000);
}));

test("capture interruption and source mutation during capture never produce a mixed native snapshot", () => fixture(f => {
  const selected = parseTeamYamlContent(yaml);
  rejected(() => RogueOneConfig.capture(f.context, { team: "rogue-one" }, selected, pair, relative => {
    if (relative === "docs/support.md") f.file("docs/global.md", "Changed while capturing dependencies");
  }), "drift");
  f.file("docs/global.md", "[Support](support.md)");
  rejected(() => RogueOneConfig.capture(f.context, { team: "rogue-one" }, selected, pair, () => { throw new Error("synthetic interruption"); }), "resource");
}));

test("absent-only materialization reconciles an acknowledged-lost save without replacing bytes", () => fixture(f => {
  const captured = f.capture(); f.start(captured);
  const archive = join(getDeployPaths(f.context.deploymentId).deployDir, "rogue-one-config.json"), before = readFileSync(archive);
  captured.materialize(f.context.deploymentId); // same original operation after a lost acknowledgement
  assert.deepEqual(readFileSync(archive), before);
  assert.equal(RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context).note, captured.note);
}));

test("UTF-8 resource bytes, including a BOM, are retained without normalization", () => fixture(f => {
  const content = "\ufeffOriginal byte-preserving resource"; f.file("docs/deep.md", content);
  const captured = f.capture(); f.start(captured);
  const projected = join(getDeployPaths(f.context.deploymentId).deployDir, "rogue-one-config/docs/deep.md");
  assert.deepEqual(readFileSync(projected), Buffer.from(content));
  rmSync(f.config, { recursive: true });
  assert.equal(RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context).read("docs/deep.md"), content);
}));

test("larger native JSON envelopes do not widen existing Review defaults or allow duplicate keys", () => {
  const raw = Buffer.from(JSON.stringify({ content: "z".repeat(1_048_576) }));
  assert.throws(() => parseReviewEvidenceJson(raw, "fixture"));
  assert.equal((parseReviewEvidenceJson(raw, "fixture", 24 * 1_048_576) as { content: string }).content.length, 1_048_576);
  assert.throws(() => parseReviewEvidenceJson(raw, "fixture", 33 * 1_048_576));
  assert.throws(() => parseReviewEvidenceJson(Buffer.from('{"x":1,"x":2}'), "fixture", 24 * 1_048_576));
});

function sensitivePolicy(root: string, field: "filenames" | "paths" | "contents", pattern: string): void {
  mkdirSync(join(root, "user"), { recursive: true });
  writeFileSync(join(root, "user/sensitive-patterns.yaml"), `${field}: [${JSON.stringify(pattern)}]\n`);
}
const regexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("PAP-349 capture rejects sensitive filenames even when JSON content is harmless", () => fixture(f => {
  f.file("docs/global.md", "[Synthetic example](credentials.json)");
  f.file("docs/credentials.json", '{"example":true}');
  rejected(f.capture, "resource");
}));

for (const field of ["filenames", "paths", "contents"] as const) {
  test(`PAP-349 capture applies configured ${field} guards to original resources`, () => fixture(f => {
    const pattern = field === "filenames" ? "^deep[.]md$" : field === "paths" ? `^${regexLiteral(join(f.config, "docs/deep.md"))}$` : "Original deep dependency";
    sensitivePolicy(f.root, field, pattern);
    rejected(f.capture, "resource");
  }));

  test(`PAP-349 current ${field} policy is rechecked at capture admission, resume and retained admission`, () => fixture(f => {
    const captured = f.capture(); f.start(captured);
    const archive = join(getDeployPaths(f.context.deploymentId).deployDir, "rogue-one-config.json"), original = readFileSync(archive);
    const retained = RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context);
    const pattern = field === "filenames" ? "^deep[.]md$" : field === "paths" ? `^${regexLiteral(join(f.config, "docs/deep.md"))}$` : "Original deep dependency";
    sensitivePolicy(f.root, field, pattern);
    rejected(() => captured.assertCurrent(), "resource");
    rmSync(f.config, { recursive: true }); // No live source is needed for retained-policy admission.
    rejected(() => RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context), "resource");
    rejected(() => retained.assertCurrent(), "resource");
    assert.deepEqual(readFileSync(archive), original, "policy rejection preserves original private evidence");
  }));
}

test("PAP-349 retained policy checks use the native original path, not the private projection", () => fixture(f => {
  const captured = f.capture(); f.start(captured);
  sensitivePolicy(f.root, "paths", `^${regexLiteral(join(getDeployPaths(f.context.deploymentId).deployDir, "rogue-one-config"))}/`);
  rmSync(f.config, { recursive: true });
  const retained = RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context);
  retained.assertCurrent();
  assert.equal(retained.read("docs/deep.md"), "Original deep dependency");
}));

test("PAP-349 policy changes also guard originally absent paths and bound policy-load errors", () => fixture(f => {
  const captured = f.capture(); f.start(captured);
  const retained = RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context);
  sensitivePolicy(f.root, "filenames", "^absent[.]md$");
  rejected(() => captured.assertCurrent(), "resource");
  rejected(() => retained.assertCurrent(), "resource");
  rejected(() => RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context), "resource");
  sensitivePolicy(f.root, "paths", "[");
  for (const check of [f.capture, () => captured.assertCurrent(), () => retained.assertCurrent(), () => RogueOneConfig.resume(f.context.deploymentId, { team: "rogue-one" }, f.context)]) {
    assert.throws(check, error => error instanceof RogueOneConfigError && error.message.length <= 2000 && !error.message.includes(f.root));
  }
}));

test("P1 diagnostics are bounded, plain and schema-owned", () => {
  const error = new RogueOneConfigError("snapshot");
  assert.ok(error.message.length <= 2000);
  for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(error.message.split(label).length - 1, 1);
  assert.doesNotMatch(error.message, /\u001b/);
});
