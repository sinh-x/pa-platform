import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTeamYamlContent } from "../yaml-parser.js";
import { CommittedConfigSource } from "../selected-config-source.js";
import { selectModeCapabilities } from "../mode-capability-selection.js";
import { createModeCapabilityBinding, parseModeCapabilityBinding, parseModeCapabilityPolicy } from "../mode-capabilities.js";
import { generatePrimer } from "../primer/index.js";
import { classifyRepositoryAccess } from "../deploy/repository-admission.js";
import { appendRegistryEvent, closeDb } from "../registry/index.js";
import { resolveTrustedTicketMutationContext } from "../tickets/store.js";

const policy = parseModeCapabilityPolicy({ version: "pa-mode-capabilities/v1", allow: ["document.package", "document.handoff", "document.local-review", "context.read"] });
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const yaml = `name: analyst\nobjective: fallback must not load\nagents:\n - name: analyst\n   role: requirements\n   instruction: docs/analyze.md\n - name: other\n   role: inactive\n   instruction: docs/inactive.md\nglobal_docs: [docs/common.md, docs/completion.md]\ndeploy_modes:\n - id: analyze\n   label: Analyze\n   agents: [analyst]\n   objective: docs/objective.md\n   document_profile: pa-document-policy/v1\n   capability_policy: ${JSON.stringify(policy)}\n   project_guides:\n     example: [docs/project.md]\n     unrelated: [docs/missing-unselected.md]\n   skills:\n    - name: method\n      inject-as: reference\n`;
const files: Record<string, string> = {
  "teams/analyst.yaml": yaml,
  "docs/analyze.md": "Selected active instruction.\n",
  "docs/common.md": "Selected methods. [Reference](reference.md)\n",
  "docs/completion.md": "Selected PUBLIC completion; {{RUNTIME_ADAPTER}}.\n",
  "docs/objective.md": "Selected public objective.\n",
  "docs/project.md": "Exact project guide.\n",
  "docs/reference.md": "Transitive reference.\n",
  "skills/global/method/SKILL.md": "Reference-only method [detail](references/detail.md).\n",
  "skills/global/method/references/detail.md": "Captured method detail.\n",
};
function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pap316-identity-"));
  try {
    for (const [path, raw] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), raw); }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-b", "fixture"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Disposable committed selection");
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function syntheticAnalystBinding(root = "/tmp/committed-analyst") {
  return { schemaVersion: "pa-mode-capability-binding/v2", configRoot: root, configRevision: "a".repeat(40),
    resourcePath: "teams/analyst.yaml", resourceSha256: hash(yaml), profile: "pa-document-policy/v1", policy,
    repoKey: "example", identity: { publicTeam: "analyst", publicMode: "analyze", effectiveTeam: "requirements", effectiveMode: "analyze", actor: "requirements/analyze" },
    resources: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, raw]) => ({ path, sha256: hash(raw) })) };
}

test("PAP-316 v2 has one strict public/effective identity; historical v1 stays exact", () => {
  const binding = syntheticAnalystBinding();
  assert.deepEqual(parseModeCapabilityBinding(binding), binding);
  const old = createModeCapabilityBinding("b".repeat(40), Buffer.from("historical"), policy);
  assert.deepEqual(parseModeCapabilityBinding(old), old);
  assert.throws(() => parseModeCapabilityBinding({ ...old, identity: binding.identity }));
  const sparse: unknown[] = new Array<unknown>(2);
  sparse[0] = { path: "teams/analyst.yaml", sha256: binding.resourceSha256 };
  assert.throws(() => parseModeCapabilityBinding({ ...binding, resources: sparse }));
  for (const change of [{ identity: { ...binding.identity, publicMode: "research" } }, { identity: { ...binding.identity, effectiveTeam: "builder" } },
    { identity: { ...binding.identity, actor: "analyst/analyze" } }, { configRoot: "/tmp/../elsewhere" }, { resourcePath: "teams/requirements.yaml" },
    { resources: [...binding.resources, binding.resources[0]] }, { resources: binding.resources.filter(resource => resource.path !== "teams/analyst.yaml") }, { arbitraryGrant: true }]) {
    assert.throws(() => parseModeCapabilityBinding({ ...binding, ...change }));
  }
});

test("PAP-316 parser admits only explicit public analyze policy, not a YAML alias or retained profile", () => {
  const team = parseTeamYamlContent(yaml);
  assert.equal(team.name, "analyst"); assert.equal(team.deploy_modes![0]!.document_profile, "pa-document-policy/v1");
  for (const variant of [yaml.replace("id: analyze", "id: investigate"), yaml.replace("name: analyst", "name: review"),
    yaml.replace("pa-document-policy/v1", "pa-document-confirmation/v3"), yaml.replace(/   capability_policy:.*\n/, ""),
    yaml + "variables:\n one: &shared {item: ordinary}\n two: *shared\n"]) assert.throws(() => parseTeamYamlContent(variant));
  const omitted = parseTeamYamlContent(yaml.replace(/   (document_profile|capability_policy):.*\n/g, ""));
  assert.equal(omitted.deploy_modes![0]!.capability_policy, undefined);
});

test("PAP-316 selector captures exact committed active and transitive resources; composer never falls back", () => fixture(root => {
  const team = parseTeamYamlContent(yaml);
  const selection = selectModeCapabilities(policy, CommittedConfigSource.at(root), { team, repoKey: "example" });
  assert.equal(selection.binding.schemaVersion, "pa-mode-capability-binding/v2");
  const parsed = parseModeCapabilityBinding(selection.binding);
  assert.deepEqual(parsed, { ...syntheticAnalystBinding(root), configRevision: selection.binding.configRevision });
  assert.ok(selection.resources);
  // Remove all physical resource access AFTER capture. Composition consumes the
  // authenticated content, while the separate pre-spawn freshness guard fails.
  writeFileSync(join(root, "docs/objective.md"), "UNAUTHENTICATED replacement");
  let filesystemFallbacks = 0;
  const primer = generatePrimer({ runtime: "pi", teamConfig: team, mode: "analyze", requirementsDocument: true,
    repository: { repoKey: "example", repoRoot: "/tmp/product" }, modeResources: selection.resources,
    resolveFile() { filesystemFallbacks++; throw new Error("legacy filesystem fallback"); }, skillsDir: "/no/legacy/skills" });
  for (const expected of ["Team: analyst", "Selected public objective", "Selected PUBLIC completion; ppa", "Captured method detail", "Transitive reference", "requirements/analyze"]) assert.ok(primer.includes(expected), expected);
  assert.doesNotMatch(primer, /UNAUTHENTICATED|fallback must not load|missing-unselected|inactive\.md/);
  assert.equal(filesystemFallbacks, 0);
  assert.equal(primer.split("Captured method detail.").length - 1, 1, "reference capture is rendered exactly once");
  assert.throws(() => selection.assertCurrent());
}));

test("PAP-334 read-only repository admission remains distinct from authenticated ticket administration", () => {
  assert.equal(classifyRepositoryAccess("analyst", "analyze"), "read-only");
  assert.equal(classifyRepositoryAccess("builder", "implement"), "exclusive-builder");
  const previous = process.env.PA_REGISTRY_DB, root = mkdtempSync(join(tmpdir(), "pap316-privilege-")); closeDb();
  process.env.PA_REGISTRY_DB = join(root, "registry.db");
  try {
    appendRegistryEvent({ deployment_id: "d-316001", team: "analyst", mode: "analyze", runtime: "pi", event: "started", timestamp: "2026-11-17T00:00:00Z" });
    assert.deepEqual(resolveTrustedTicketMutationContext({ deploymentId: "d-316001" }, false), { team: "analyst", mode: "analyze", privileged: true });
  } finally { closeDb(); if (previous === undefined) delete process.env.PA_REGISTRY_DB; else process.env.PA_REGISTRY_DB = previous; rmSync(root, { recursive: true, force: true }); }
});
