import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AutoDelegationPolicyService, RegistryDocumentJournal, workflowDigest, type NativeAutoPolicyHost, type AutoDelegationPolicy } from "@pa-platform/pa-core";
import { autoPolicyFixture } from "../../../pa-core/src/__tests__/auto-policy-fixture.js";
import { delegatedDraftFixture } from "./auto-delegated-draft-fixture.js";
import { capturePiAutoPolicy, createPiAutoPolicyHost, piAutoDraftPolicyAuthority } from "../auto-policy.js";
import { autoPolicyDiagnostic, runPiAutoPolicyCommand } from "../auto-policy-cli.js";
import { selectedPiAutoDelegatedPair } from "../auto-delegated-contract.js";
import type { AutoTerminal } from "../auto-terminal.js";
import type { PiAutoShortlistPair } from "../auto-shortlist-contract.js";

// SIMULATED foreground/input/installed-runtime facts. No real policy adoption,
// native human UAT, installed pairing or provider/worker qualification is claimed.
function uiFixture(selected = 0) {
  const f = autoPolicyFixture(), displayed: string[] = []; let choices = 0;
  f.policy.domain.principal = `local-uid:${userInfo().uid}`;
  const documents = new RegistryDocumentJournal(f.db), service = new AutoDelegationPolicyService(documents);
  const terminal: AutoTerminal = { authenticate() {}, display: text => displayed.push(text), async choose() { choices++; assert.equal(documents.autoPolicyEvents(host.domain).at(-1)!.data.phase, "requested"); return selected; } };
  const host: NativeAutoPolicyHost = { ...f.host, domain: workflowDigest(JSON.stringify(f.policy.domain)), capture: (r, policy) => capturePiAutoPolicy(r, policy, terminal) };
  return { ...f, documents, service, terminal, host, displayed, choices: () => choices };
}
test("native policy UI adapter displays full exact scope after durable claim and default/empty input cancels", async () => {
  for (const selected of [0, -1]) {
    const f = uiFixture(selected); try {
      const errors: string[] = [], code = await runPiAutoPolicyCommand(["adopt"], { stdout() {}, stderr: s => errors.push(s) }, f);
      assert.equal(code, 0, errors.join("\n")); assert.equal(f.choices(), 1); assert.match(f.displayed.join("\n"), /Full exact policy/); assert.match(f.displayed.join("\n"), /human-before-integration/);
      const state = f.service.status(f.host.domain); assert.equal(Boolean(state.issuedAdoption), selected === 0); assert.equal(state.executionAdmitted, false); assert.equal(state.activationRequested, false);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM auto_items").get().n, 0); assert.equal(f.db.prepare("SELECT count(*) AS n FROM deployments").get().n, 0);
    } finally { f.db.close(); }
  }
});
test("actual revoke/withdraw adapter paths retain original scope and require no routine per-ticket approval", async () => {
  const f = uiFixture(); try {
    await f.service.adopt(f.host); const original = f.service.status(f.host.domain).issuedAdoption!;
    assert.equal(await runPiAutoPolicyCommand(["revoke"], { stdout() {}, stderr() {} }, f), 0);
    assert.equal(f.service.status(f.host.domain).lastDecision!.target, original.decisionId); assert.equal(f.choices(), 2); assert.equal(f.service.status(f.host.domain).issuedAdoption, null);
  } finally { f.db.close(); }
  const w = uiFixture(); try {
    const held = new AutoDelegationPolicyService(w.documents, stage => { if (stage === "requested") throw new Error("request interrupted"); });
    await assert.rejects(held.adopt(w.host)); assert.equal(await runPiAutoPolicyCommand(["withdraw"], { stdout() {}, stderr() {} }, w), 0);
    assert.equal(w.service.status(w.host.domain).pendingReviews.length, 0); assert.equal(w.choices(), 1); assert.equal(w.service.status(w.host.domain).issuedAdoption, null);
  } finally { w.db.close(); }
});
test("actor/outcome/yes/path/JSON mutation flags reject before UI, native owner or registry effects", async () => {
  const f = uiFixture(); try {
    for (const args of [["adopt", "--json"], ["adopt", "--yes"], ["adopt", "--actor", "sinh"], ["revoke", "--outcome", "approved"], ["adopt", "--policy-file", "/tmp/fake.json"], ["withdraw", "--json"], ["status", "--json", "--json"]]) {
      const output: string[] = [];
      assert.equal(await runPiAutoPolicyCommand(args, { stdout: s => output.push(s), stderr: s => output.push(s) }, f), 1);
      if (args.includes("--json")) { const parsed = JSON.parse(output[0]!); assert.equal(parsed.code, "AUTO_INPUT"); assert.equal(parsed.executionAdmitted, false); }
    }
    assert.equal(f.choices(), 0); assert.equal(f.documents.autoPolicyEvents(f.host.domain).length, 0);
    const errors: string[] = []; assert.equal(await runPiAutoPolicyCommand(["adopt"], { stdout() {}, stderr: s => errors.push(s) }, { ...f, terminal: { ...f.terminal, authenticate() { throw new Error("private-sentinel"); } } }), 1);
    assert.doesNotMatch(errors.join("\n"), /private-sentinel/); assert.equal(f.documents.autoPolicyEvents(f.host.domain).length, 0);
  } finally { f.db.close(); }
});
test("full policy displayed scope must match its exact original hash", async () => {
  const f = uiFixture(); try {
    let request: any; const capture = f.host.capture; f.host.capture = async (r, p) => { request = r; return capture(r, p); };
    await f.service.adopt(f.host); const shown = f.displayed.length;
    await assert.rejects(capturePiAutoPolicy({ ...request, policySha256: "0".repeat(64) }, f.policy, f.terminal)); assert.equal(f.displayed.length, shown);
  } finally { f.db.close(); }
});
test("policy diagnostics are bounded, plain, exact-label and cannot interpolate hostile context", () => {
  for (const code of ["AUTO_BUSY", "AUTO_SOURCE", "AUTO_UNAVAILABLE", "AUTO_INPUT", "Source:\nprivate-sentinel\u001b".repeat(300), { toString() { throw new Error("unsafe interpolation"); } }]) {
    const text = autoPolicyDiagnostic(code as any); assert.ok(text.length <= 2000); assert.doesNotMatch(text, /private-sentinel|\u001b/);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(text.split(label).length, 2);
  }
  assert.match(autoPolicyDiagnostic("AUTO_UNAVAILABLE", "effect-owner-bridge"), /no admitted r003/);
});
test("actual noninteractive CLI uses existing-only status and never initializes or captures permission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-policy-cli-")); try {
    const env = { ...process.env, PA_AI_USAGE_HOME: join(root, "missing"), PA_REGISTRY_DB: join(root, "missing/registry.db"), NO_COLOR: "1" };
    const run = (args: string[]) => spawnSync(process.execPath, ["--import=tsx", new URL("../cli.ts", import.meta.url).pathname, "auto", "policy", ...args], { env, encoding: "utf8", timeout: 15000, maxBuffer: 1048576 });
    const status = run(["status", "--json"]); assert.equal(status.status, 1, status.stderr); assert.equal(JSON.parse(status.stdout).reason, "not-initialized");
    const invalid = run(["adopt", "--json"]); assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stdout).code, "AUTO_INPUT");
    const headless = run(["adopt"]); assert.equal(headless.status, 1); assert.match(headless.stderr, /Automatic policy review did not complete/);
    assert.equal(existsSync(join(root, "missing")), false); assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("production full-scope adoption remains held without actual effect bridge even with pairing/runtime flags", async () => {
  const f = await delegatedDraftFixture(); try {
    const terminal: AutoTerminal = { authenticate() {}, display() {}, async choose() { throw new Error("must not prompt"); } };
    const host = createPiAutoPolicyHost(terminal, { authenticate: () => "1".repeat(64), runtime: () => ({ sourceSha: "a".repeat(40), configSha: "b".repeat(40), packageVersion: "fixture", storeRoot: "/fixture/install" }) });
    assert.throws(() => host.propose(), error => Object.getOwnPropertyDescriptor(error, "policyGate")?.value === "effect-owner-bridge");
    assert.equal(new AutoDelegationPolicyService(new RegistryDocumentJournal(f.journal.db)).status(host.domain).revision, 0); assert.equal(f.count(), 0);
  } finally { f.close(); }
});
test("implementation objective is implicitly pinned even when omitted from the explicit resource list", async () => {
  const f = await delegatedDraftFixture(); try {
    const builder = join(f.cfg, "teams/builder.yaml");
    f.put(builder, readFileSync(builder, "utf8").replace("    label: Native builder\n", "    label: Native builder\n    objective: skills/implementation.md\n"));
    f.put(join(f.cfg, "skills/implementation.md"), "Use only the original finite local intent and actual native admissions.\n");
    execFileSync("git", ["-C", f.cfg, "add", "."]); execFileSync("git", ["-C", f.cfg, "commit", "-m", "Synthetic objective identity fixture"], { stdio: "ignore" });
    const pair = selectedPiAutoDelegatedPair(); assert.equal(pair.implementation.objective.path, "skills/implementation.md");
    f.put(join(f.cfg, "skills/implementation.md"), "Changed unlisted objective bytes.\n"); assert.throws(() => pair.assertCurrent()); assert.throws(() => selectedPiAutoDelegatedPair()); assert.equal(f.count(), 0);
  } finally { f.close(); }
});

test("native subject compiler binds actual registered roots/profiles/config and rejects drift; test bridge callbacks are not qualification", async () => {
  const f = await delegatedDraftFixture(); try {
    const manifest = readFileSync(join(f.repo, "checks.json"), "utf8"), policy = { schemaVersion: "pa-auto-delegation-definition/v1", lifetimeSeconds: 3600, repositories: ["pa-platform", "pa-platform-config"].map(key => ({ key, sourceScope: { files: ["README.md"], directories: [], newPaths: [] }, checkIds: ["fixture-check"] })) };
    for (const [name, text] of [["README.md", "# Fixture config\n"], ["check.sh", "exit 0\n"], ["checks.json", manifest], ["policies/auto-delegation.json", JSON.stringify(policy)]]) f.put(join(f.cfg, name!), text!);
    const userPath = join(f.root, "user/config.yaml"), config = JSON.parse(readFileSync(userPath, "utf8")); config.repos["pa-platform-config"].projectCommands = { manifest: "checks.json", sha256: workflowDigest(manifest) }; f.put(userPath, JSON.stringify(config));
    execFileSync("git", ["-C", f.cfg, "add", "."]); execFileSync("git", ["-C", f.cfg, "commit", "-m", "Synthetic native policy compile fixtures only"], { stdio: "ignore" });
    const pair = selectedPiAutoDelegatedPair();
    const shortlist: PiAutoShortlistPair = { schemaVersion: "pa-auto-shortlist-pair/v1", configRoot: pair.configRoot, configRevision: pair.configRevision, resourcesSha256: "1".repeat(64), observationScopeSha256: "2".repeat(64), reasoning: { team: "requirements", mode: "auto-reasoning", provider: "fixture", model: "fixture-model", instructions: "Synthetic scope", objective: { path: "skills/reasoning.md", sha256: "a".repeat(64) } }, timezone: "UTC", goalSources: [{ pathTemplate: "daily/{date}.md", dateFormat: "iso", heading: "Focus" }], assertCurrent: () => pair.assertCurrent() };
    const host = createPiAutoPolicyHost({ authenticate() {}, display() {}, async choose() { return -1; } }, { authenticate: () => "1".repeat(64), pair: () => pair, shortlistPair: () => shortlist, assertEffectsSupported() {}, runtime: () => ({ sourceSha: "a".repeat(40), configSha: pair.configRevision, packageVersion: "fixture-only", storeRoot: "/fixture/install" }) });
    const subject: AutoDelegationPolicy = host.propose(); host.assertCurrent(subject); assert.equal(subject.repositories.length, 2); assert.equal(subject.repositories[0]!.root, f.repo); assert.equal(subject.roles.draft.mode, "auto-draft-delegated");
    f.put(join(f.cfg, "skills/draft.md"), "Changed original native resources."); assert.throws(() => host.assertCurrent(subject)); assert.equal(f.count(), 0);
    // Existing observation-only choice is NOT silently upgraded by a policy ref.
    assert.throws(() => piAutoDraftPolicyAuthority(f.journal, host).authorizeDraft(f.item, f.shortlists.selectionForItem(f.item.itemId)!));
  } finally { f.close(); }
});
