import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MODE_CAPABILITIES, MODE_CAPABILITY_POLICY_VERSION, MODE_CAPABILITY_PROFILE, MODE_CAPABILITY_SESSION, parseModeCapabilityPolicy, selectedCapabilityTools, capabilityToolSelected, createModeCapabilityBinding, parseModeCapabilityBinding, modeCapabilityDiagnostic } from "../mode-capabilities.js";
import { parseTeamYaml, parseTeamYamlContent } from "../yaml-parser.js";
import { selectModeCapabilities } from "../mode-capability-selection.js";
import { CommittedConfigSource } from "../selected-config-source.js";
import { appendRegistryEvent, getDeploymentEvents, queryDeploymentStatus, computeDeploymentStatuses } from "../registry/index.js";
import { closeDb } from "../registry/db.js";
const policy = (allow: string[] = []) => ({ version: MODE_CAPABILITY_POLICY_VERSION, allow });
const config = (value: unknown = policy(), profile = MODE_CAPABILITY_PROFILE) => `name: requirements\nobjective: test\nagents: []\ndeploy_modes:\n  - id: analyze\n    document_profile: ${profile}\n    capability_policy: ${JSON.stringify(value)}\n`;

test("closed registry is exact replacement selection with immutable deterministic results", () => {
  assert.equal(new Set(MODE_CAPABILITIES.map(c => c.id)).size, MODE_CAPABILITIES.length);
  assert.equal(new Set(MODE_CAPABILITIES.map(c => c.tool)).size, MODE_CAPABILITIES.length);
  assert.deepEqual(selectedCapabilityTools(parseModeCapabilityPolicy(policy())), []);
  const all = parseModeCapabilityPolicy(policy(MODE_CAPABILITIES.map(c => c.id).reverse()));
  assert.equal(all.allow.length, 11);
  assert.ok(Object.isFrozen(all)); assert.ok(Object.isFrozen(all.allow));
  assert.deepEqual(all.allow, [...all.allow].sort());
  for (const entry of MODE_CAPABILITIES) {
    assert.equal(entry.profile, MODE_CAPABILITY_PROFILE); assert.ok(entry.owner); assert.ok(entry.actions);
    const selected = parseModeCapabilityPolicy(policy([entry.id]));
    assert.deepEqual(selectedCapabilityTools(selected), [entry.tool]);
    assert.equal(capabilityToolSelected(selected, entry.tool), true);
    for (const alias of [`functions.${entry.tool}`, `mcp.${entry.tool}`, entry.tool.toUpperCase(), `${entry.tool}*`]) assert.equal(capabilityToolSelected(selected, alias), false);
  }
});

test("invalid present policies never drop keys, truncate, inherit, or fall back", () => {
  for (const invalid of [null, [], true, "", {}, { allow: [] }, { version: MODE_CAPABILITY_POLICY_VERSION }, policy(["context.read", "context.read"]), policy(["*"]), policy(["context.*"]), policy(["read"]), policy(["../read"]), policy(["é"]), policy(["a".repeat(129)]), policy(Array(65).fill("context.read")), { ...policy(), version: "v2" }, { ...policy(), allow: null }, { ...policy(), allow: [1] }, { ...policy(), command: "inert-canary" }, { ...policy(), headers: {} }, { ...policy(), authority: true }]) {
    assert.throws(() => parseModeCapabilityPolicy(invalid));
    assert.throws(() => parseTeamYamlContent(config(invalid)));
  }
  // 64 and 128 satisfy resource bounds but unknown IDs still reject as unknown.
  assert.throws(() => parseModeCapabilityPolicy(policy(Array.from({ length: 64 }, (_, n) => `unknown.${n}`))), /CAPABILITY_UNKNOWN/);
  assert.throws(() => parseModeCapabilityPolicy(policy(["a".repeat(128)])), /CAPABILITY_UNKNOWN/);
  assert.throws(() => parseTeamYamlContent(config().replace('"allow":[]', '"allow":[],"allow":[]')), /duplicated mapping key/);
  assert.throws(() => parseTeamYamlContent(config() + "    capability_policy: null\n"), /duplicated mapping key/);
  assert.throws(() => parseTeamYamlContent(config().replace('capability_policy:', 'capability_policy: &p\n      <<: {version: pa-mode-capabilities/v1}\n      extra:')));
  assert.throws(() => parseTeamYamlContent(config().replace("id: analyze", "id: review-auto")));
  assert.throws(() => parseTeamYamlContent(config().replace("name: requirements", "name: builder")));
  assert.throws(() => parseTeamYamlContent(config().replace(/    capability_policy:.+\n/, "")));
  assert.throws(() => parseTeamYamlContent(config(policy(), "pa-document-confirmation/v3" as typeof MODE_CAPABILITY_PROFILE)));
  const exact = config() + "#" + " ".repeat(65536 - Buffer.byteLength(config()) - 1);
  assert.ok(parseTeamYamlContent(exact)); assert.throws(() => parseTeamYamlContent(exact + " "));
});

test("retained absent-policy profiles preserve parsed behavior; new bindings are strict", () => {
  for (const profile of ["pa-document-package/v1", "pa-document-workspace/v2", "pa-document-confirmation/v3"]) {
    const retained = parseTeamYamlContent(config().replace(MODE_CAPABILITY_PROFILE, profile).replace(/    capability_policy:.+\n/, ""));
    assert.equal(retained.deploy_modes![0]!.capability_policy, undefined);
    assert.equal(retained.deploy_modes![0]!.document_profile, profile);
  }
  const binding = createModeCapabilityBinding("a".repeat(40), Buffer.from(config()), policy());
  assert.deepEqual(parseModeCapabilityBinding(JSON.parse(JSON.stringify(binding))), binding);
  for (const change of [{ profile: "retained" }, { configRevision: "latest" }, { resourcePath: "/tmp/policy" }, { resourceSha256: "x" }, { grant: true }, { policy: policy(["bash"]) }]) assert.throws(() => parseModeCapabilityBinding({ ...binding, ...change }));
});

test("selected committed resource binds exact bytes/revision and rejects drift/foreign selection", () => {
  const root = mkdtempSync(join(tmpdir(), "mode-policy-"));
  try {
    mkdirSync(join(root, "teams")); writeFileSync(join(root, "teams/requirements.yaml"), config(policy(["context.read"])));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
    git("init", "-b", "fixture"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    const selection = selectModeCapabilities(policy(["context.read"]), CommittedConfigSource.at(root));
    assert.equal(selection.binding.configRevision, git("rev-parse", "HEAD")); selection.assertCurrent();
    assert.throws(() => selectModeCapabilities(policy(), CommittedConfigSource.at(root)));
    writeFileSync(join(root, "teams/requirements.yaml"), config());
    assert.throws(() => selection.assertCurrent());
    assert.throws(() => selectModeCapabilities(policy(), CommittedConfigSource.at(root)));
    writeFileSync(join(root, "bad.yaml"), Buffer.from([0xff])); assert.throws(() => parseTeamYaml(join(root, "bad.yaml")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native registry persists selection and forbids later widening or changed replay", () => {
  const old = process.env.PA_REGISTRY_DB, root = mkdtempSync(join(tmpdir(), "mode-policy-registry-")); closeDb();
  process.env.PA_REGISTRY_DB = join(root, "registry.db");
  try {
    const binding = JSON.stringify(createModeCapabilityBinding("a".repeat(40), Buffer.from(config()), policy()));
    const event = { deployment_id: "d-aabbcd", team: "requirements", mode: "analyze", event: "started" as const, timestamp: "2026-11-10T00:00:00Z", runtime: "pi", note: MODE_CAPABILITY_SESSION, mode_capability_binding: binding };
    appendRegistryEvent(event);
    assert.equal(getDeploymentEvents(event.deployment_id)[0]!.mode_capability_binding, binding);
    assert.equal(queryDeploymentStatus(event.deployment_id)!.mode_capability_binding, binding);
    assert.equal(computeDeploymentStatuses(getDeploymentEvents(event.deployment_id))[0]!.mode_capability_binding, binding);
    assert.throws(() => appendRegistryEvent({ ...event, mode_capability_binding: "{}" }), /immutable/);
    assert.throws(() => appendRegistryEvent({ ...event, event: "updated", mode_capability_binding: "{}" }), /immutable/);
    closeDb(); assert.equal(queryDeploymentStatus(event.deployment_id)!.mode_capability_binding, binding);
  } finally { closeDb(); if (old === undefined) delete process.env.PA_REGISTRY_DB; else process.env.PA_REGISTRY_DB = old; rmSync(root, { recursive: true, force: true }); }
});

test("plain policy blockers are fixed, bounded and side-effect-free", () => {
  for (const code of ["CAPABILITY_POLICY_INVALID", "CAPABILITY_UNKNOWN", "CAPABILITY_PROFILE", "CAPABILITY_UNAVAILABLE", "CAPABILITY_BINDING", "CAPABILITY_OMITTED"] as const) {
    const message = modeCapabilityDiagnostic(code);
    assert.ok(message.length <= 2000); assert.ok(!message.includes("\u001b"));
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(message.split(label).length, 2);
    for (const label of ["Impact:", "Actor:", "New approval:", "Prerequisite:"]) assert.ok(message.includes(label));
  }
});
