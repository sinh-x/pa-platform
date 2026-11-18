import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommittedConfigSource } from "../selected-config-source.js";
import { selectModeCapabilities } from "../mode-capability-selection.js";
import { hasModeResources, MODE_CAPABILITY_SESSION, READONLY_DOCUMENT_PROFILE, READONLY_DOCUMENT_SESSION, modeCapabilityActor, modeCapabilityRouteMatches, modeCapabilitySessionMatches, parseModeCapabilityBinding, parseModeCapabilityPolicy, selectedCapabilityTools } from "../mode-capabilities.js";
import { parseTeamYamlContent } from "../yaml-parser.js";
import { generatePrimer } from "../primer/index.js";

const policy = (allow: string[]) => parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow });
function config(name = "analyst", ids = ["analyze", "investigate", "research"]) {
  return { name, description: "Config-owned workflow", agents: [{ name: "evidence", role: "Document researcher", instruction: "docs/agent.md" }, { name: "inactive", role: "Unselected", instruction: "docs/missing.md" }],
    default_mode: ids[0], global_docs: ["docs/common.md"], deploy_modes: ids.map((id, i) => ({ id, label: id, agents: ["evidence"], objective: `docs/${id}.md`,
      document_profile: READONLY_DOCUMENT_PROFILE, capability_policy: policy(i === 0 ? ["document.package", "document.handoff", "document.local-review"] : ["ticket.intake", "context.read"]),
      project_guides: { example: ["docs/project.md"], elsewhere: ["docs/not-selected.md"] }, skills: [{ name: "method", "inject-as": "reference" }] })) };
}
function fixture(run: (root: string, commit: () => void) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap318-profile-"));
  try {
    const files = { "teams/analyst.yaml": JSON.stringify(config()), "docs/agent.md": "Config-defined agent.", "docs/common.md": "[Reference](reference.md)", "docs/reference.md": "Transitive exact bytes.",
      "docs/project.md": "Selected project.", "docs/analyze.md": "Analyze; prepare a handoff.", "docs/investigate.md": "Evidence-backed diagnosis and repair direction; do not implement; feed analyze.",
      "docs/research.md": "Sourced comparison and recommendation; feed analyze.", "skills/global/method/SKILL.md": "Method [details](details.md)", "skills/global/method/details.md": "Exact method details." };
    for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), body); }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-b", "fixture");
    const commit = () => { git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Committed inert configuration"); };
    commit(); run(root, commit);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("PAP-318 documented inert example matches the strict runtime contract without activating configuration", () => {
  const doc = readFileSync(new URL("../../../../docs/readonly-document-profile.md", import.meta.url), "utf8"), example = /```yaml\n([\s\S]*?)\n```/.exec(doc)?.[1];
  assert.ok(example); const team = parseTeamYamlContent(example);
  assert.equal(team.name, "evidence-lab"); assert.equal(team.deploy_modes![0]!.document_profile, READONLY_DOCUMENT_PROFILE);
  assert.deepEqual(team.deploy_modes![0]!.capability_policy!.allow, ["capability.discover", "context.read", "human.question", "ticket.intake"]);
});

test("PAP-318 new profile strictly validates names, fields, supported finite capabilities and YAML trees", () => {
  assert.equal(parseTeamYamlContent(JSON.stringify(config())).name, "analyst");
  const invalid: unknown[] = [
    { ...config(), actor: "builder/implement" }, { ...config(), root: "/foreign" }, { ...config(), agents: [{ name: "agent", role: "x", permission: "write" }] },
    { ...config(), deploy_modes: [config().deploy_modes[0], config().deploy_modes[0]] },
  ];
  for (const change of [{ document_profile: "unknown/v1" }, { effective_role: "builder" }, { capability_policy: { version: "pa-mode-capabilities/v1", allow: ["unknown"] } },
    { capability_policy: policy(["workflow.request"]) }, { capability_policy: policy(["decision.request"]) }, { capability_policy: undefined },
    { agents: ["absent"] }, { objective: "../foreign" }, { skills: [{ name: "method", "inject-as": "execute" }] }]) {
    invalid.push({ ...config(), deploy_modes: [{ ...config().deploy_modes[0]!, ...change }] });
  }
  for (const malformed of [["work"], {}, 1, null, true]) {
    invalid.push({ ...config(), deploy_modes: [{ ...config().deploy_modes[0]!, mode_type: malformed }] });
    invalid.push({ ...config(), deploy_modes: [{ ...config().deploy_modes[0]!, skills: [{ name: "method", "inject-as": malformed }] }] });
  }
  invalid.push({ ...config(), deploy_modes: [{ ...config().deploy_modes[0]!, skills: [{ name: "method", "inject-as": ["reference"] }] }] });
  for (const value of invalid) assert.throws(() => parseTeamYamlContent(JSON.stringify(value)));
  const yaml = `name: analysis-lab\nagents: []\ndeploy_modes:\n - id: report\n   label: Report\n   objective: docs/report.md\n   document_profile: ${READONLY_DOCUMENT_PROFILE}\n   capability_policy: {version: pa-mode-capabilities/v1, allow: []}\n`;
  assert.throws(() => parseTeamYamlContent(yaml + "variables:\n A: &shared {value: plain}\n B: *shared\n"));
  assert.throws(() => parseTeamYamlContent(yaml.replace("allow: []", "allow: [], actor: builder")));
});

test("PAP-318 committed three modes and config-only add/edit/rename bind exact identity, graph, policy and primer", () => fixture((root, commit) => {
  const select = (name: string, mode: string) => {
    const team = parseTeamYamlContent(readFileSync(join(root, `teams/${name}.yaml`), "utf8"));
    const selected = team.deploy_modes!.find(entry => entry.id === mode)!;
    return { team, ...selectModeCapabilities(selected.capability_policy!, CommittedConfigSource.at(root), { team, mode, repoKey: "example" }) };
  };
  for (const mode of ["analyze", "investigate", "research"]) {
    const selection = select("analyst", mode), binding = selection.binding;
    assert.equal(binding.schemaVersion, "pa-mode-capability-binding/v3"); assert.ok(hasModeResources(binding));
    assert.equal(binding.identity.publicMode, mode); assert.equal(modeCapabilityActor(binding), "requirements/analyze");
    assert.equal(modeCapabilityRouteMatches(binding, "analyst", mode), true); assert.equal(modeCapabilityRouteMatches(binding, "requirements", "analyze"), false);
    assert.equal(modeCapabilitySessionMatches(binding, MODE_CAPABILITY_SESSION), false); assert.equal(modeCapabilitySessionMatches(binding, READONLY_DOCUMENT_SESSION), true);
    assert.deepEqual(binding.resources.map(file => file.path).sort(), ["teams/analyst.yaml", `docs/${mode}.md`, "docs/agent.md", "docs/common.md", "docs/reference.md", "docs/project.md", "skills/global/method/SKILL.md", "skills/global/method/details.md"].sort());
    assert.deepEqual([...selectedCapabilityTools(binding.policy)].sort(), mode === "analyze" ? ["pa_document", "pa_handoff"] : ["pa_ticket_intake", "read"]);
    const primer = generatePrimer({ runtime: "pi", teamConfig: selection.team, mode, requirementsDocument: true, modeResources: selection.resources,
      repository: { repoKey: "example", repoRoot: "/tmp/product" }, resolveFile() { assert.fail("No mutable fallback"); } });
    for (const expected of [`Team: analyst`, `Mode: ${mode}`, "Transitive exact bytes", "Exact method details", "Config-defined agent", "requirements/analyze"]) assert.ok(primer.includes(expected), expected);
    assert.doesNotMatch(primer, /docs\/missing|not-selected|Public identity: requirements/);
    assert.throws(() => parseModeCapabilityBinding({ ...binding, schemaVersion: "pa-mode-capability-binding/v2" }));
    for (const fields of [{ actor: "builder" }, { profile: "writer/v1" }, { identity: { ...binding.identity, effectiveTeam: "builder" } }, { identity: { ...binding.identity, actor: "analyst/research" } }]) assert.throws(() => parseModeCapabilityBinding({ ...binding, ...fields }));
  }
  let authored = config("evidence-lab", ["survey"]);
  writeFileSync(join(root, "teams/evidence-lab.yaml"), JSON.stringify(authored)); writeFileSync(join(root, "docs/survey.md"), "Original custom report."); commit();
  const original = select("evidence-lab", "survey");
  authored.agents[0]!.instruction = "docs/new-agent.md"; authored.deploy_modes[0]!.capability_policy = policy(["human.question"]);
  writeFileSync(join(root, "docs/new-agent.md"), "Changed agent and objective."); writeFileSync(join(root, "docs/survey.md"), "Edited custom report.");
  writeFileSync(join(root, "teams/evidence-lab.yaml"), JSON.stringify(authored)); commit();
  assert.throws(() => original.assertCurrent());
  const edited = select("evidence-lab", "survey"); assert.deepEqual(selectedCapabilityTools(edited.binding.policy), ["question"]);
  assert.notEqual(edited.binding.configRevision, original.binding.configRevision); assert.equal(original.binding.policy.allow.includes("human.question"), false);
  authored = { ...authored, name: "insight-desk", default_mode: "compare", deploy_modes: [{ ...authored.deploy_modes[0]!, id: "compare" }] };
  renameSync(join(root, "teams/evidence-lab.yaml"), join(root, "teams/insight-desk.yaml")); writeFileSync(join(root, "teams/insight-desk.yaml"), JSON.stringify(authored)); commit();
  const renamed = select("insight-desk", "compare"); assert.equal(modeCapabilityRouteMatches(renamed.binding, "insight-desk", "compare"), true);
  assert.equal(modeCapabilityRouteMatches(renamed.binding, "evidence-lab", "survey"), false);
}));

for (const kind of ["dirty", "missing", "symlink", "hardlink", "drift"]) test(`PAP-318 selected profile rejects ${kind} resources through the committed source owner`, () => fixture(root => {
  const team = parseTeamYamlContent(readFileSync(join(root, "teams/analyst.yaml"), "utf8")), source = CommittedConfigSource.at(root);
  const select = () => selectModeCapabilities(team.deploy_modes![1]!.capability_policy!, source, { team, mode: "investigate", repoKey: "example" });
  const selected = kind === "drift" ? select() : undefined, path = join(root, "docs/reference.md");
  if (kind === "dirty" || kind === "drift") writeFileSync(path, "Uncommitted replacement");
  else { rmSync(path); if (kind === "symlink") symlinkSync(join(root, "docs/common.md"), path); if (kind === "hardlink") linkSync(join(root, "docs/common.md"), path); }
  assert.throws(() => selected ? selected.assertCurrent() : select());
}));
