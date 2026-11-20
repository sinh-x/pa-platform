import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { generatePrimer } from "../primer/index.js";
import { CommittedConfigSource } from "../selected-config-source.js";
import { readSelectedModeResource, selectModeCapabilities } from "../mode-capability-selection.js";
import { parseSelectedPrimerBudget } from "../selected-mode-resources.js";
import { hasModeResources, type ModeResourceSnapshot } from "../mode-capabilities.js";
import { parseTeamYamlContent } from "../yaml-parser.js";

const modes = ["analyze", "investigate", "research"];
const budgets = JSON.stringify({ $schema: "contracts/schemas/primer-budgets.schema.json", kind: "pa-primer-budgets", contractVersion: "1.0.0", unit: "lines", defaultMax: 1200,
  modes: modes.map(mode => ({ team: "analyst", mode, max: 9000 })) });
const teamRaw = JSON.stringify({ name: "analyst", description: "Selected lean fixture", agents: modes.map(name => ({ name, role: name, instruction: `docs/${name}.md` })),
  default_mode: "analyze", global_docs: ["docs/common.md", "docs/dispatch.md", "docs/completion.md", "docs/contract.md", "docs/gate.md"],
  deploy_modes: modes.map(id => ({ id, label: id, objective: "docs/objective.md", agents: [id], global_docs: ["docs/common.md"], document_profile: "pa-readonly-document/v1",
    capability_policy: { version: "pa-mode-capabilities/v1", allow: ["ordinary.read"] }, skills: [{ name: "optional", "inject-as": "reference" }] })) });
function leanFixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pap327-lean-"));
  try {
    const files: Record<string, string> = { "teams/analyst.yaml": teamRaw, "primers/budgets.yaml": budgets,
      "docs/objective.md": "OBLIGATION-objective\n", "docs/common.md": "OBLIGATION-common [Optional](../skills/global/optional/SKILL.md)\n",
      "docs/dispatch.md": "OBLIGATION-dispatch\n", "docs/completion.md": "OBLIGATION-completion {{RUNTIME_ADAPTER}}\n",
      "docs/contract.md": "OBLIGATION-contract\n", "docs/gate.md": "OBLIGATION-gate\n",
      "skills/global/optional/SKILL.md": "# Optional method\n[Detail](references/detail.md)\nOPTIONAL-BODY\n".repeat(40),
      "skills/global/optional/references/detail.md": "OPTIONAL-DETAIL é\r\n[Last](last.md)\r\n",
      "skills/global/optional/references/last.md": "OPTIONAL-LAST\n", "docs/unselected.md": "UNSELECTED\n" };
    for (const mode of modes) files[`docs/${mode}.md`] = `OBLIGATION-agent-${mode}\n`;
    for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), body); }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-b", "fixture"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fresh disposable committed lean fixture");
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function selected(root: string, mode: string) {
  const team = parseTeamYamlContent(teamRaw), selection = selectModeCapabilities(team.deploy_modes!.find(m => m.id === mode)!.capability_policy!, CommittedConfigSource.at(root), { team, mode, repoKey: "example" });
  assert.ok(selection.resources);
  return { team, ...selection, resources: selection.resources };
}
function compose(root: string, mode: string, resources?: ModeResourceSnapshot) {
  const selection = selected(root, mode);
  return generatePrimer({ runtime: "pi", teamConfig: selection.team, mode, requirementsDocument: true, modeResources: resources ?? selection.resources,
    repository: { repoKey: "example", repoRoot: "/tmp/fixture-product" }, resolveFile() { assert.fail("No mutable fallback"); } });
}
for (const mode of modes) test(`PAP-327 ${mode}: selected budget, complete active obligations once, thin optional metadata and honest counts`, () => leanFixture(root => {
  const primer = compose(root, mode);
  assert.match(primer, /budget=9000/);
  for (const obligation of ["objective", `agent-${mode}`, "common", "dispatch", "completion", "contract", "gate"]) {
    assert.equal(primer.split(`OBLIGATION-${obligation}`).length - 1, 1, obligation);
  }
  assert.doesNotMatch(primer, /OPTIONAL-BODY|OPTIONAL-DETAIL|OPTIONAL-LAST|UNSELECTED/);
  assert.match(primer, /selected-resource:skills\/global\/optional\/references\/last.md/);
  const signal = /lines=(\d+) chars=(\d+) .*budget=(\d+) over=(true|false)/.exec(primer)!;
  assert.equal(Number(signal[1]), primer.split("\n").length); assert.equal(Number(signal[2]), primer.length);
  assert.equal(signal[4], String(primer.split("\n").length > Number(signal[3])));
}));
test("PAP-327 on-demand exact transitive bytes survive mutable edits and a newer committed HEAD without changing selection", () => leanFixture(root => {
  const selection = selected(root, "analyze"), before = JSON.stringify(selection.binding);
  const path = "skills/global/optional/references/detail.md", original = "OPTIONAL-DETAIL é\r\n[Last](last.md)\r\n";
  writeFileSync(join(root, path), "MUTABLE replacement");
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-am", "New unrelated configuration"], { cwd: root, stdio: "pipe" });
  assert.equal(readSelectedModeResource(selection.binding, path), original);
  assert.equal(readSelectedModeResource(selection.binding, "skills/global/optional/references/last.md"), "OPTIONAL-LAST\n");
  assert.equal(JSON.stringify(selection.binding), before); assert.throws(() => selection.assertCurrent());
  const primer = generatePrimer({ runtime: "pi", teamConfig: selection.team, mode: "analyze", requirementsDocument: true, modeResources: selection.resources, repository: { repoKey: "example", repoRoot: "/tmp/product" } });
  assert.doesNotMatch(primer, /MUTABLE|OPTIONAL-DETAIL|OPTIONAL-LAST/);
}));
test("PAP-327 resource reads reject unselected, unavailable, corrupt and invalid paths without widening or fallback", () => leanFixture(root => {
  const selection = selected(root, "research"), binding = selection.binding; assert.ok(hasModeResources(binding));
  for (const path of ["docs/unselected.md", "docs/investigate.md", "docs/never-selected.md"]) assert.throws(() => readSelectedModeResource(binding, path), /CAPABILITY_OMITTED/);
  for (const path of ["../outside.md", "/docs/objective.md", "docs/..%2f/objective.md", "docs/./objective.md"]) assert.throws(() => readSelectedModeResource(binding, path), /CAPABILITY_BINDING/);
  const path = "skills/global/optional/references/detail.md";
  const corrupt = { ...binding, resources: binding.resources.map(r => r.path === path ? { ...r, sha256: "0".repeat(64) } : r) };
  assert.throws(() => readSelectedModeResource(corrupt, path), /CAPABILITY_BINDING/);
  assert.throws(() => readSelectedModeResource({ ...binding, configRevision: "0".repeat(40) }, path), /CAPABILITY_BINDING/);
  // A new uncached object whose bytes do not match its claimed object ID must
  // fail even though the physical Git namespace and current HEAD remain valid.
  const corruptCommit = "c".repeat(40), commitBody = `tree ${"0".repeat(40)}\n\nCorrupt disposable object\n`;
  mkdirSync(join(root, ".git/objects/cc"), { recursive: true });
  writeFileSync(join(root, ".git/objects/cc", corruptCommit.slice(2)), deflateSync(Buffer.from(`commit ${Buffer.byteLength(commitBody)}\0${commitBody}`)));
  assert.throws(() => readSelectedModeResource({ ...binding, configRevision: corruptCommit }, path), /CAPABILITY_BINDING/);
  const missing = { ...binding, resources: [...binding.resources, { path: "docs/missing.md", sha256: "1".repeat(64) }].sort((a, b) => a.path.localeCompare(b.path)) };
  assert.throws(() => readSelectedModeResource(missing, "docs/missing.md"), /CAPABILITY_BINDING/);
}));
test("PAP-327 fresh Analyst selection requires exact valid committed budget evidence", () => leanFixture(root => {
  rmSync(join(root, "primers/budgets.yaml")); assert.throws(() => selected(root, "analyze"));
  writeFileSync(join(root, "primers/budgets.yaml"), budgets.replace("9000", "9999")); assert.throws(() => selected(root, "analyze"));
  for (const body of ["{}", budgets.replace('"unit":"lines"', '"unit":"bytes"'), budgets.replace('"mode":"analyze"', '"mode":"elsewhere"'), budgets.replace("9000", "-1"), budgets.replace('"mode":"research"', '"mode":"analyze"')]) {
    assert.throws(() => parseSelectedPrimerBudget(body, "analyst", "analyze"), /CAPABILITY_BINDING/);
  }
  assert.equal(parseSelectedPrimerBudget(budgets.replace('"team":"analyst","mode":"analyze","max":9000', '"team":"analyst","mode":"analyze","max":17'), "analyst", "analyze"), 17);
}));
test("PAP-327 retained snapshots never opt in from inventory alone; fresh corrupt/missing budget capture fails closed", () => leanFixture(root => {
  const selection = selected(root, "analyze"), original = selection.resources;
  const retained = compose(root, "analyze", { binding: original.binding, read: path => original.read(path) });
  assert.match(retained, /OPTIONAL-BODY/); assert.match(retained, /budget=1200/);
  assert.throws(() => compose(root, "analyze", { ...original, read: path => path === "primers/budgets.yaml" ? budgets.replaceAll("9000", "9001") : original.read(path) }), /CAPABILITY_BINDING/);
  assert.throws(() => compose(root, "analyze", { ...original, binding: { ...original.binding, resources: original.binding.resources.filter(r => r.path !== "primers/budgets.yaml") } }), /CAPABILITY_BINDING/);
}));
test("PAP-327 selected over flag follows the actual selected team/mode budget, not the static mode default", () => leanFixture(root => {
  writeFileSync(join(root, "primers/budgets.yaml"), budgets.replaceAll("9000", "17"));
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-am", "Exact smaller selected budget"], { cwd: root, stdio: "pipe" });
  const primer = compose(root, "analyze"); assert.match(primer, /budget=17 over=true/);
}));
test("PAP-327 same captured pair: lean analyze/investigate are smaller than retained full-capture controls", () => leanFixture(root => {
  for (const mode of ["analyze", "investigate"]) {
    const selection = selected(root, mode); assert.ok(hasModeResources(selection.binding));
    // A pre-P3 binding has no budget resource and retains its full-capture behavior.
    const binding = { ...selection.binding, resources: selection.binding.resources.filter(r => r.path !== "primers/budgets.yaml") };
    const control = compose(root, mode, { binding, read: path => selection.resources.read(path) });
    const lean = compose(root, mode);
    assert.ok(lean.split("\n").length < control.split("\n").length);
    assert.ok(Buffer.byteLength(lean) < Buffer.byteLength(control));
    assert.match(control, /OPTIONAL-BODY/); assert.match(control, /budget=1200/);
  }
}));
