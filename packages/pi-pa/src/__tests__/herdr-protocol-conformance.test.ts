import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  observePeerTarget, HERDR_PEER_TARGET, type HerdrPeerAgent,
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

test("protocol-22 cleanup grammar has no expected-incarnation conditional", () => {
  assert.deepEqual(Object.keys(defs["PaneClearAgentAuthorityParams"]!.properties!).sort(), ["pane_id", "seq", "source"]);
  assert.deepEqual(Object.keys(defs["PaneReleaseAgentParams"]!.properties!).sort(), ["agent", "pane_id", "seq", "source"]);
  // Structural validity says nothing about official-source no-ops or removal.
  assert.deepEqual(violations(defs["PaneClearAgentAuthorityParams"]!, { pane_id: binding.paneId, source: "herdr:pi", seq: 13 }), []);
});

test("managed incarnation uses the supported source-qualified release and native resume fields", () => {
  const source = "ppa:pi:11111111-1111-4111-8111-111111111111";
  assert.deepEqual(violations(defs["PaneReleaseAgentParams"]!, { pane_id: binding.paneId, source, agent: "pi", seq: 8 }), []);
  assert.deepEqual(violations(defs["PaneReportAgentParams"]!, { ...herdrStateParams(binding, "idle", 7), source, resume_argv: ["pi", "--session", "/tmp/session.jsonl"] }), []);
});

test("source-derived counterexamples reject treating shared-source sequences as retirement guards", () => {
  // Deliberately small model of public Herdr ee5bfb5 state.rs:1742-1808.
  // This characterizes the safety gap; it is NOT installed-server acceptance
  // or a substitute for a future actual-server race test.
  const pane = () => {
    let current: string | undefined, watermark = 0;
    return {
      report(incarnation: string, seq: number) { if (seq > watermark) { current = incarnation; watermark = seq; } },
      clear(seq: number) { if (current !== undefined && seq > watermark) { current = undefined; watermark = seq; } },
      get current() { return current; },
    };
  };
  const delayedClear = pane(), unrelated = pane();
  delayedClear.report("A", 10); unrelated.report("other", 20);
  delayedClear.report("B", 12); // same shell after A's local timeout/return
  delayedClear.clear(13); // A's queued request is still applicable to B
  assert.equal(delayedClear.current, undefined, "a higher seq can delete the replacement");
  assert.equal(unrelated.current, "other");

  const absentAuthority = pane();
  absentAuthority.clear(12); // early-return path records no fence
  absentAuthority.report("A", 11);
  assert.equal(absentAuthority.current, "A", "late old state resurrects without an absent-authority fence");
  const ordered = pane(); ordered.report("A", 10); ordered.clear(12); ordered.report("A", 11);
  assert.equal(ordered.current, undefined, "a watermark only helps where it is actually retained");
});

const agent = (overrides: Partial<HerdrPeerAgent> = {}): HerdrPeerAgent => ({
  pane_id: "w1:p3A", agent: "pi", agent_status: "idle", completion_seq: 4, state_change_seq: 12,
  interactive_ready: true, launch_pending: false, cwd: "/home/inert/peer-worktree",
  agent_session: { kind: "path", value: "/home/inert/sessions/peer.jsonl" }, ...overrides,
});
const decide = (overrides: Partial<Parameters<typeof observePeerTarget>[0]> = {}) => observePeerTarget({
  ownPaneId: "w1:p2Z", requestedPaneId: "w1:p3A", agents: [agent()], ...overrides,
});
const reason = (overrides: Partial<Parameters<typeof observePeerTarget>[0]> = {}) => {
  const decision = decide(overrides);
  return decision.ok ? "observed" : decision.reason;
};

test("a complete preliminary observation still leaves send admission unavailable", () => {
  assert.equal(HERDR_PEER_TARGET.test("w1:p3A"), true);
  assert.equal(HERDR_PEER_TARGET.test("w1/p3A"), false);
  assert.equal(HERDR_PEER_TARGET.test("w1:p3A\n"), false);
  for (const agent_status of ["idle", "done"]) {
    const decision = decide({ expectedCwd: "/home/inert/peer-worktree", agents: [agent({ agent_status })] });
    assert.equal(decision.ok, true);
    if (!decision.ok) continue;
    assert.deepEqual(decision.observation, {
      target: "w1:p3A", sendAdmission: "unavailable", baseline: { completionSeq: 4, stateChangeSeq: 12 },
      sessionRef: "/home/inert/sessions/peer.jsonl",
    });
    assert.equal("admission" in decision, false, "paths and readiness are not authenticated deployment/read-only authority");
  }
});

test("preliminary observation rejects self, malformed, absent, ambiguous and unsettled targets", () => {
  assert.equal(reason({ requestedPaneId: "w1:p2Z" }), "self");
  for (const requestedPaneId of ["../p3A", "w1:p3A\n"]) assert.equal(reason({ requestedPaneId }), "invalid-target");
  assert.equal(reason({ ownPaneId: "unknown" }), "invalid-self");
  assert.equal(reason({ requestedPaneId: "w1:p9Z" }), "unknown");
  assert.equal(reason({ agents: [agent(), agent({ completion_seq: 5 })] }), "ambiguous");
  for (const [agent_status, expected] of [["working", "busy"], ["blocked", "blocked"], ["unknown", "unknown-state"], ["garbage", "unknown-state"]]) {
    assert.equal(reason({ agents: [agent({ agent_status })] }), expected);
  }
});

test("missing or malformed readiness never passes the preliminary filter", () => {
  assert.equal(reason({ agents: [{ pane_id: "w1:p3A", agent_status: "idle" }] }), "not-ready");
  for (const interactive_ready of [false, undefined, null, 1, "true"]) {
    assert.equal(reason({ agents: [agent({ interactive_ready: interactive_ready as boolean })] }), "not-ready");
  }
  for (const launch_pending of [true, undefined, null, 0, "false"]) {
    assert.equal(reason({ agents: [agent({ launch_pending: launch_pending as boolean })] }), "not-ready");
  }
});

test("unknown or invalid ordering baselines are refused instead of defaulting to zero", () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "5", true]) {
    for (const key of ["completion_seq", "state_change_seq"] as const) {
      assert.equal(reason({ agents: [agent({ [key]: value as number })] }), "unknown-baseline", `${key}: ${String(value)}`);
    }
  }
  const zero = decide({ agents: [agent({ completion_seq: 0, state_change_seq: 0 })] });
  assert.equal(zero.ok, true, "explicit zero is different from an absent counter");
  if (zero.ok) assert.deepEqual(zero.observation.baseline, { completionSeq: 0, stateChangeSeq: 0 });
  assert.equal(reason({ agents: [agent({ agent_status: "done", completion_seq: null })] }), "unknown-baseline");
});

test("unknown session references and checkout mismatches remain unsupported", () => {
  for (const agent_session of [
    null, undefined, { kind: "id", value: "s-inert" }, { kind: "path", value: "relative.jsonl" },
    { kind: "path", value: "/tmp/bad\nsession" }, { kind: "path", value: `/${"x".repeat(1024)}` },
    { kind: "path", value: null },
  ]) {
    assert.equal(reason({ agents: [agent({ agent_session })] }), "unknown-session");
  }
  for (const expectedCwd of ["/home/inert/other-worktree", "relative/checkout", "/tmp/bad\ncheckout"]) {
    assert.equal(reason({ expectedCwd }), "identity-mismatch");
  }
  assert.equal(reason({ agents: [agent({ cwd: null, foreground_cwd: null })], expectedCwd: "/home/inert/peer-worktree" }), "identity-mismatch");
  assert.equal(reason({ agents: [agent({ cwd: null, foreground_cwd: "/home/inert/peer-worktree" })], expectedCwd: "/home/inert/peer-worktree" }), "observed");
});
