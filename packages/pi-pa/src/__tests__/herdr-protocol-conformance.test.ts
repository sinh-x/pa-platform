import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  admitPeerTarget, HERDR_PEER_TARGET, type HerdrPeerAgent,
} from "../pi-extension/herdr-peer-admission.js";
import { herdrSessionParams, herdrStateParams, type HerdrBinding } from "../pi-extension/herdr-lifecycle.js";

type Schema = {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly minimum?: number;
  readonly $ref?: string;
};

const fixture = JSON.parse(readFileSync(new URL("./fixtures/herdr-protocol-22.json", import.meta.url), "utf8")) as {
  provenance: { protocol: number; schemaVersion: number };
  defs: Record<string, Schema>;
};
const defs = fixture.defs;
const deref = (schema: Schema): Schema => {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split("/").at(-1)!;
  assert.ok(defs[name], `fixture must define ${name}`);
  return defs[name]!;
};

/** Minimal structural check of the fixture's own subset: required keys, JSON
 * types, enums, uint bounds and array items. It validates our outgoing params
 * against Herdr's bundled protocol-22 definitions without adding a dependency. */
function violations(schema: Schema, value: unknown, path = "$"): string[] {
  const resolved = deref(schema);
  const found: string[] = [];
  if (resolved.enum && !resolved.enum.some(entry => entry === value)) found.push(`${path}: not in enum`);
  const types = resolved.type === undefined ? undefined : Array.isArray(resolved.type) ? resolved.type : [resolved.type];
  if (types) {
    const matches = types.some(type => {
      if (type === "null") return value === null;
      if (type === "array") return Array.isArray(value);
      if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
      if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
      if (type === "number") return typeof value === "number" && Number.isFinite(value);
      return typeof value === type;
    });
    if (!matches) { found.push(`${path}: type`); return found; }
  }
  if (typeof value === "number" && typeof resolved.minimum === "number" && value < resolved.minimum) found.push(`${path}: minimum`);
  if (Array.isArray(value) && resolved.items) value.forEach((item, index) => found.push(...violations(resolved.items!, item, `${path}[${index}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of resolved.required ?? []) if ((value as Record<string, unknown>)[key] === undefined) found.push(`${path}.${key}: required`);
    for (const [key, property] of Object.entries(resolved.properties ?? {})) {
      const actual = (value as Record<string, unknown>)[key];
      if (actual !== undefined) found.push(...violations(property, actual, `${path}.${key}`));
    }
  }
  return found;
}

const binding: HerdrBinding = { socketPath: "/run/inert/herdr.sock", paneId: "w1:p2Z" };

test("fixture provenance pins the protocol it validates", () => {
  assert.equal(fixture.provenance.protocol, 22);
  assert.equal(fixture.provenance.schemaVersion, 1);
  assert.deepEqual(defs["PaneAgentState"]?.enum, ["idle", "working", "blocked", "unknown"]);
});

test("lifecycle payloads conform to the bundled Herdr protocol-22 definitions", () => {
  const sessions = [
    {},
    { sessionId: "s-inert" },
    { sessionPath: "/tmp/session.jsonl" },
    { sessionId: "s-inert", sessionPath: "/tmp/session.jsonl", reason: "startup" },
    { reason: "line one\nline two" },
  ];
  for (const state of ["idle", "working", "blocked"] as const) {
    for (const session of sessions) {
      assert.deepEqual(violations(defs["PaneReportAgentParams"]!, herdrStateParams(binding, state, 1, state === "blocked" ? "approval" : undefined, session)), []);
    }
  }
  for (const session of sessions) assert.deepEqual(violations(defs["PaneReportAgentSessionParams"]!, herdrSessionParams(binding, session, 1)), []);
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["PaneReportAgentParams", { ...herdrStateParams(binding, "idle", 1), state: "done" }],
    ["PaneReportAgentParams", { ...herdrStateParams(binding, "idle", 1), state: undefined }],
    ["PaneReportAgentParams", { ...herdrStateParams(binding, "idle", 1), pane_id: undefined }],
    ["PaneReportAgentSessionParams", { ...herdrSessionParams(binding, {}, 1), agent: undefined }],
    ["PaneReportAgentParams", { ...herdrStateParams(binding, "idle", 1), seq: -1 }],
  ];
  for (const [name, payload] of invalid) assert.notDeepEqual(violations(defs[name]!, payload), [], `${name} ${JSON.stringify(payload)}`);
});

const agent = (overrides: Partial<HerdrPeerAgent> = {}): HerdrPeerAgent => ({
  pane_id: "w1:p3A", agent: "pi", agent_status: "idle", completion_seq: 4, state_change_seq: 12,
  interactive_ready: true, launch_pending: false, cwd: "/home/inert/peer-worktree",
  agent_session: { kind: "path", value: "/home/inert/sessions/peer.jsonl" }, ...overrides,
});
const decide = (overrides: Partial<Parameters<typeof admitPeerTarget>[0]> = {}) => admitPeerTarget({
  ownPaneId: "w1:p2Z", requestedPaneId: "w1:p3A", agents: [agent()], ...overrides,
});

test("peer admission accepts only one idle, ready, expected-checkout pane and captures its baseline", () => {
  assert.equal(HERDR_PEER_TARGET.test("w1:p3A"), true);
  assert.equal(HERDR_PEER_TARGET.test("w1/p3A"), false);
  const decision = decide({ expectedCwd: "/home/inert/peer-worktree" });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.deepEqual(decision.admission, {
    target: "w1:p3A", baseline: { completionSeq: 4, stateChangeSeq: 12 }, sessionRef: "/home/inert/sessions/peer.jsonl",
  });
  assert.equal(decide({ agents: [agent({ agent_status: "done", completion_seq: null })] }).ok, true, "a settled agent is accepted with an unknown completion baseline");
  assert.equal(decide({ agents: [agent({ completion_seq: null })], expectedCwd: "/home/inert/peer-worktree" }).ok, true);
});

test("peer admission rejects self, unknown, ambiguous, not-ready, busy, blocked and identity changes", () => {
  const reason = (overrides: Partial<Parameters<typeof admitPeerTarget>[0]> = {}) => {
    const decision = decide(overrides);
    return decision.ok ? "accepted" : decision.reason;
  };
  assert.equal(reason({ requestedPaneId: "w1:p2Z" }), "self");
  assert.equal(reason({ requestedPaneId: "../p3A" }), "invalid-target");
  assert.equal(reason({ requestedPaneId: "w1:p9Z" }), "unknown");
  assert.equal(reason({ agents: [agent(), agent({ completion_seq: 5 })] }), "ambiguous");
  assert.equal(reason({ agents: [agent({ launch_pending: true })] }), "not-ready");
  assert.equal(reason({ agents: [agent({ interactive_ready: false })] }), "not-ready");
  assert.equal(reason({ agents: [agent({ agent_status: "working" })] }), "busy");
  assert.equal(reason({ agents: [agent({ agent_status: "blocked" })] }), "blocked");
  assert.equal(reason({ agents: [agent({ agent_status: "unknown" })] }), "unknown-state");
  assert.equal(reason({ expectedCwd: "/home/inert/other-worktree" }), "identity-mismatch");
  assert.equal(reason({ expectedCwd: "relative/checkout" }), "identity-mismatch");
  assert.equal(reason({ agents: [agent({ cwd: null, foreground_cwd: null })], expectedCwd: "/home/inert/peer-worktree" }), "identity-mismatch");
  assert.equal(reason({ agents: [agent({ agent_session: { kind: "id", value: "s-inert" } })] }), "accepted");
  const noSession = decide({ agents: [agent({ agent_session: null })] });
  assert.equal(noSession.ok && noSession.admission.sessionRef, undefined);
});
