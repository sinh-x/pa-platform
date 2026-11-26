import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RogueOneConfig, RogueOneConfigError, selectRogueOneMode, type RogueOneConfigContext } from "../deploy/rogue-one-config.js";
import { appendRegistryEvent, closeDb } from "../registry/index.js";
import { getDeployPaths } from "../deploy/paths.js";
import { parseTeamYamlContent } from "../yaml-parser.js";

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

test("P1 missing, unsupported, aliased and oversized dependencies fail closed", () => fixture(f => {
  const deep = join(f.config, "docs/deep.md"); rmSync(deep); rejected(f.capture);
  f.file("docs/deep.md", "[Script](../scripts/run.js)"); f.file("scripts/run.js", "import './dynamic.js'"); rejected(f.capture, "resource");
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

test("P1 diagnostics are bounded, plain and schema-owned", () => {
  const error = new RogueOneConfigError("snapshot");
  assert.ok(error.message.length <= 2000);
  for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(error.message.split(label).length - 1, 1);
  assert.doesNotMatch(error.message, /\u001b/);
});
