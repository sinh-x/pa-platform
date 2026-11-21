import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { associateDeploymentTicket, closeDb, CommittedConfigSource, emitPidEvent, emitStartedEvent, ensureDeployDir, parseTeamYamlContent, READONLY_DOCUMENT_SESSION, selectModeCapabilities, type ModeCapabilityBinding } from "@pa-platform/pa-core";
import { authenticatePiReadonlyDocumentCaller } from "../document-session.js";
import { recordPiProcessIdentity } from "../process-identity.js";
import { assertSelectedResourceRead, createSelectedResourceReadTool } from "../pi-extension/selected-resource-read.js";
import type { PiToolDefinition } from "../pi-extension/index.js";

for (const capability of ["ordinary.read", "context.read", "omitted"]) test(`PAP-327 native selected-reference read: ${capability}, exact bytes and confined failures`, async () => {
  const prior = { ...process.env }, cwd = process.cwd(), root = mkdtempSync(join(tmpdir(), "pap327-native-read-")); closeDb();
  const config = join(root, "config"), repo = join(root, "repo"), usage = join(root, "usage"), path = "skills/global/method/details.md";
  const original = "\ufeffEXACT selected é\r\nsecond line\r\n", raw = JSON.stringify({ name: "analyst", agents: [], global_docs: [], deploy_modes: [{ id: "research", label: "Research", objective: "docs/objective.md", document_profile: "pa-readonly-document/v1",
    capability_policy: { version: "pa-mode-capabilities/v1", allow: capability === "omitted" ? [] : [capability] }, skills: [{ name: "method", "inject-as": "reference" }] }] });
  try {
    for (const directory of [config, repo, usage]) mkdirSync(directory);
    const files = { "config.yaml": `repos:\n example:\n  path: ${repo}\n  prefix: EX\n`, "teams/analyst.yaml": raw, "docs/objective.md": "Selected objective.",
      "primers/budgets.yaml": JSON.stringify({ $schema: "contracts/schemas/primer-budgets.schema.json", kind: "pa-primer-budgets", contractVersion: "1.0.0", unit: "lines", defaultMax: 1200, modes: [{ team: "analyst", mode: "research", max: 9000 }] }),
      "skills/global/method/SKILL.md": "[Detail](details.md) [Long](long.md)", "skills/global/method/long.md": "x".repeat(49 * 1024), [path]: original, "docs/unselected.md": "Never selected." };
    for (const [file, body] of Object.entries(files)) { mkdirSync(join(config, file, ".."), { recursive: true }); writeFileSync(join(config, file), body); }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: config, stdio: "pipe" });
    git("init", "-b", "fixture"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Disposable selected references");
    execFileSync("git", ["init", "-b", "fixture"], { cwd: repo, stdio: "pipe" });
    const team = parseTeamYamlContent(raw), selection = selectModeCapabilities(team.deploy_modes![0]!.capability_policy!, CommittedConfigSource.at(config), { team, mode: "research", repoKey: "example" });
    for (const key of Object.keys(process.env)) if (/^(PA_|PI_)/.test(key)) delete process.env[key];
    Object.assign(process.env, { PA_PLATFORM_HOME: config, PA_PLATFORM_CONFIG: config, PA_PLATFORM_TEAMS: join(config, "teams"), PA_PLATFORM_SKILLS: join(config, "skills/global"), PA_AI_USAGE_HOME: usage, PA_REGISTRY_DB: join(root, "registry.db") });
    process.chdir(repo);
    const context = { cwd: repo, mode: "tui" as const, sessionManager: { getSessionId: () => "disposable-native-session" } };
    let sequence = 0, fallbackReads = 0;
    const fallback: PiToolDefinition = { name: "read", label: "Read", description: "Existing guarded read", parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }), execute: async () => { fallbackReads++; return { content: [{ type: "text", text: "retained read" }], details: {} }; } };
    const launch = (binding: ModeCapabilityBinding = selection.binding) => {
      const id = `d-32700${++sequence}`, directory = ensureDeployDir(id);
      emitStartedEvent({ deploymentId: id, team: "analyst", mode: "research", runtime: "pi", binary: "ppa", repo, repoRoot: repo, worktreeRoot: repo, note: READONLY_DOCUMENT_SESSION, modeCapabilityBinding: JSON.stringify(binding) });
      emitPidEvent({ deploymentId: id, team: "analyst", pid: process.pid }); assert.equal(recordPiProcessIdentity(id, directory, process.pid), true);
      Object.assign(process.env, { PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: directory, PA_TEAM: "analyst", PA_MODE: "research", PA_REPO: repo, PA_WORKTREE_ROOT: repo, PA_PI_EXECUTION_MODE: "foreground" });
      const identity = authenticatePiReadonlyDocumentCaller(context);
      return { tool: createSelectedResourceReadTool(identity, fallback), identity };
    };
    const { tool, identity } = launch();
    const read = (input: Record<string, unknown>, ctx: unknown = context, signal?: AbortSignal) => tool.execute("read-selected", input, signal, undefined, ctx);
    const input = { path: `selected-resource:${path}` };
    if (capability === "omitted") {
      assert.equal((await read(input)).details.code, "CAPABILITY_OMITTED");
      assert.throws(() => assertSelectedResourceRead(identity, input, context), /CAPABILITY_OMITTED/); return;
    }
    assertSelectedResourceRead(identity, input, context);
    const before = JSON.stringify(authenticatePiReadonlyDocumentCaller(context).capabilities);
    writeFileSync(join(config, path), "MUTABLE replacement");
    const result = await read(input); assert.equal(result.isError, undefined); assert.equal(result.content[0].text, original);
    assert.equal(result.details.status, "reference-only"); assert.equal(result.details.complete, true);
    assert.equal((await read({ path: "selected-resource:skills/global/method/long.md" })).details.code, "LOCAL_CONTENT_LIMIT");
    const first = await read({ ...input, limit: 1 });
    const rest = await read({ ...input, offset: first.details.nextOffset });
    assert.equal(first.content[0].text + rest.content[0].text, original);
    assert.equal(JSON.stringify(authenticatePiReadonlyDocumentCaller(context).capabilities), before);
    mkdirSync(join(usage, "tickets"), { recursive: true });
    writeFileSync(join(usage, "tickets/EX-001.json"), JSON.stringify({ id: "EX-001", project: "example", title: "Disposable associated ticket", status: "idea", assignee: "sinh", createdAt: "2026-11-21T00:00:00Z", updatedAt: "2026-11-21T00:00:00Z" }));
    associateDeploymentTicket({ deploymentId: identity.deploymentId, ticketId: "EX-001", expectedTicketId: null, actor: "requirements/analyze", reason: "Disposable owner-driven association" });
    assert.notEqual(authenticatePiReadonlyDocumentCaller(context).identitySha256, identity.identitySha256);
    assertSelectedResourceRead(identity, input, context);
    assert.equal((await read(input)).content[0].text, original, "same native session keeps its resource binding after ticket association");
    writeFileSync(join(config, "sensitive-patterns.yaml"), JSON.stringify({ content_patterns: ["second line"] }));
    const withheld = await read({ ...input, limit: 1 }); assert.equal(withheld.details.code, "LOCAL_CONTENT_POLICY"); assert.equal(withheld.isError, true); assert.doesNotMatch(withheld.content[0].text, /EXACT selected|second line/);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(withheld.content[0].text.split(label).length, 2);
    assert.ok(withheld.content[0].text.length <= 2000); assert.doesNotMatch(withheld.content[0].text, /\u001b/);
    writeFileSync(join(config, "sensitive-patterns.yaml"), "["); assert.equal((await read(input)).details.code, "LOCAL_CONTENT_POLICY", "unavailable security policy never permits raw bytes");
    rmSync(join(config, "sensitive-patterns.yaml"));
    for (const invalid of [{ path: "selected-resource:docs/unselected.md" }, { path: "selected-resource:../outside.md" }, { ...input, offset: 0 }, { ...input, limit: 2001 }, { ...input, source: "public-web-response" }]) assert.equal((await read(invalid)).isError, true);
    assert.equal((await read(input, { ...context, sessionManager: { getSessionId: () => "different-session" } })).isError, true);
    assert.equal((await read(input, context, AbortSignal.abort())).isError, true);
    assert.equal(fallbackReads, 0, "selected errors never fall through to mutable reads");
    assert.equal((await read({ path: "ordinary-file", limit: 5000 })).content[0].text, "retained read"); assert.equal(fallbackReads, 1);
    assert.equal(tool.parameters, fallback.parameters, "unselected read schema is unchanged");
    assert.ok("resources" in selection.binding);
    const corrupt = { ...selection.binding, resources: selection.binding.resources.map(r => r.path === path ? { ...r, sha256: "0".repeat(64) } : r) };
    const changed = launch(corrupt);
    assert.equal((await changed.tool.execute("corrupt", input, undefined, undefined, context)).details.code, "CAPABILITY_BINDING");
    assert.equal((await read(input)).isError, true, "an old wrapper cannot switch deployments");
    const unavailable = launch({ ...selection.binding, configRevision: "0".repeat(40) });
    assert.equal((await unavailable.tool.execute("missing", input, undefined, undefined, context)).details.code, "CAPABILITY_BINDING");
    const missing = launch({ ...selection.binding, resources: [...selection.binding.resources, { path: "docs/missing.md", sha256: "1".repeat(64) }].sort((a, b) => a.path.localeCompare(b.path)) });
    assert.equal((await missing.tool.execute("missing-resource", { path: "selected-resource:docs/missing.md" }, undefined, undefined, context)).details.code, "CAPABILITY_BINDING");
    assert.equal(fallbackReads, 1);
  } finally { closeDb(); process.chdir(cwd); process.env = prior; rmSync(root, { recursive: true, force: true }); }
});
