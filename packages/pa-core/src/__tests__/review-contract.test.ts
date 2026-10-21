import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertReviewContractAgreement, formatReviewContractDiagnostic, MAX_REVIEW_ARTIFACT_BYTES,
  MAX_REVIEW_OBJECTIVE_BYTES, parseReviewMatrix, parseReviewMatrixArtifact, parseReviewMatrixSource,
  parseReviewObjective, parseReviewReadinessBinding, readReviewMatrixArtifact, readReviewObjectiveFile,
  ReviewContractError, inspectReviewMatrix, inspectReviewObjective, type ReviewContractErrorCode, type ReviewMatrix, type ReviewMatrixApproval,
  type ReviewObjective,
} from "../validation/review-contract.js";

const fixtures = fileURLToPath(new URL("./fixtures/protected-review-v1/", import.meta.url));
const names = ["producer-node-pnpm", "mvm-179-migrated", "nx-055-migrated", "mvm-181-migrated"];
const fixture = (name: string): Buffer => fs.readFileSync(join(fixtures, name));
const objective = (name = names[0]!): ReviewObjective => parseReviewObjective(fixture(`${name}.objective.json`));
const fixtureAuthorization = objective().reviewAuthorizationId;
const artifact = (name = names[0]!) => parseReviewMatrixArtifact(fixture(`${name}.md`), objective(name).matrixSource);
const matrixJson = (name = names[0]!): string => JSON.stringify(artifact(name).matrix);
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const approval = (o: ReviewObjective): ReviewMatrixApproval => ({ commentId: o.matrixApprovalEvidence, author: "sinh", ticket: o.ticket, branch: o.branch, matrixSource: o.matrixSource, matrixAuthoritySha256: o.matrixAuthoritySha256 });
function rejects(fn: () => unknown, code?: ReviewContractErrorCode, source?: string): ReviewContractError {
  let result: ReviewContractError | undefined;
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ReviewContractError);
    if (code) assert.equal(e.code, code);
    if (source) assert.equal(e.diagnostic.source, source);
    const message = formatReviewContractDiagnostic(e);
    assert.ok(message.length <= 2000);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) assert.ok(message.includes(`${label}: `));
    assert.ok(!message.includes(fixtureAuthorization));
    result = e; return true;
  });
  return result!;
}
function temporary(run: (root: string) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pap-237-contract-")));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function installArtifact(root: string): string {
  const o = objective(); const path = join(root, o.matrixSource.slice("requirements:".length));
  fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, fixture(`${names[0]}.md`));
  return path;
}
function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (path: string): void => {
    for (const entry of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { entries.push(`dir:${child}`); walk(child); }
      else entries.push(`file:${child}:${digest(fs.readFileSync(child))}`);
    }
  };
  walk(root); return entries;
}

test("isolated producers cover all three profiles and exact synthetic bindings without live authority", () => {
  for (const name of names) {
    const o = objective(name); const a = artifact(name);
    assert.equal(o.ticket, "FIX-237"); assert.equal(a.digest, o.matrixAuthoritySha256);
    assertReviewContractAgreement(o, a, { ticket: "FIX-237", repository: a.matrix.repository, approval: approval(o) });
    assert.equal(a.matrix.commandCount, 1);
    assert.equal(a.matrix.commands[0]!.command, 'PA_PHASE5_CONFIG_ROOT=/fixture/config printf "fixture only\\n"');
    assert.equal(Object.keys(a.matrix.environment).length, 11);
    // Repeated parsing/agreement remains observational; no one-use claim, reservation or attempt is made.
    assertReviewContractAgreement(o, a, { ticket: "FIX-237", repository: a.matrix.repository, approval: approval(o) });
  }
  assert.equal(artifact("mvm-179-migrated").matrix.profile, "npm-subprojects/v1");
  assert.equal(artifact("nx-055-migrated").matrix.profile, "non-node-nix/v1");
  assert.deepEqual(artifact("mvm-181-migrated").matrix.prerequisites.filter((p) => p.kind === "dependency").map((p) => p.root), ["backend", "frontend"]);
});

test("formatting whitespace is permitted, shell whitespace is unchanged, authority strings are not normalized", () => {
  const o = objective(); assert.deepEqual(parseReviewObjective(` \n${JSON.stringify(o, null, 4)}\r\n `), o);
  const m = artifact().matrix; m.commands[0]!.command = "  printf 'fixture'\n\n";
  assert.equal(parseReviewMatrix(JSON.stringify(m)).commands[0]!.command, m.commands[0]!.command);
  for (const field of ["ticket", "branch", "featureSha", "matrixSource", "matrixAuthoritySha256", "matrixApprovalEvidence", "reviewAuthorizationId"] as const) {
    rejects(() => parseReviewObjective(JSON.stringify({ ...o, [field]: ` ${o[field]}` })), "REVIEW_FIELD");
  }
});

const inlineCommandCases = [
  ["exact historical NODE_ENV=test TZ=UTC assignment pair", `NODE_ENV=test TZ=UTC node -e 'if(process.env.NODE_ENV!=="test" || process.env.TZ!=="UTC") process.exit(1)'`],
  ["leading trailing and internal shell whitespace", " \tNODE_ENV=test  TZ=UTC\tprintf '%s' 'café'\r\n\n "],
  ["quoted command-local value containing spaces", `NODE_ENV='test mode' printf '%s' "quoted value"`],
  ["multiple command-local assignments", `NODE_ENV=test TZ=UTC CI=1 printf '%s' "$NODE_ENV"`],
  ["opaque env -u NODE_ENV command text", `env -u NODE_ENV TZ=UTC node -e 'if(process.env.NODE_ENV!==undefined) process.exit(1)'`],
] as const;
const launcherNames = ["PA_REPO", "PA_FEATURE_SHA", "PA_MATRIX_SOURCE", "PA_MATRIX_AUTHORITY_SHA256", "PA_MATRIX_APPROVAL_EVIDENCE", "PATH", "PA_TICKET_ID", "CI", "HOME", "LANG", "TZ"].sort();
function artifactWithPayload(payload: string): Buffer {
  const original = fixture(`${names[0]}.md`).toString();
  let changed = original.replace(/(```json\n)[\s\S]*?(\n```)/, (_match, open: string, close: string) => open + payload + close);
  const section = changed.slice(changed.indexOf("### Full Validation Matrix"), changed.indexOf("## After Matrix"));
  changed = changed.replace(objective().matrixAuthoritySha256, digest(Buffer.from(section)));
  return Buffer.from(changed);
}
for (const escaped of [false, true]) for (const [name, command] of inlineCommandCases) test(`parser/artifact preserve ${name} and command order with exactly eleven launcher names (${escaped ? "escaped" : "literal"} JSON)`, () => {
  const m = artifact().matrix; const originalEnvironment = structuredClone(m.environment);
  m.commands = ["printf before", command, "printf after"].map((shell, i) => ({ ...m.commands[0]!, id: `ordered-${i}`, command: shell }));
  m.commandCount = m.commands.length; m.outputs = m.commands.map((c) => `${c.id}: fixture only`);
  // Also decode JSON escapes: source spelling is not permission to rewrite shell text.
  const payload = escaped ? JSON.stringify(m).replace(/NODE_ENV/g, "\\u004eODE_ENV") : JSON.stringify(m);
  const parsed = parseReviewMatrix(payload); const a = parseReviewMatrixArtifact(artifactWithPayload(payload), m.source);
  assert.deepEqual(parsed.commands, m.commands); assert.deepEqual(a.matrix.commands, m.commands);
  assert.deepEqual(Buffer.from(a.matrix.commands[1]!.command), Buffer.from(command));
  assert.deepEqual(a.matrix.environment, originalEnvironment);
  assert.deepEqual(Object.keys(parsed.environment).sort(), launcherNames); assert.equal(Object.keys(parsed.environment).length, 11);
  assert.equal(Object.hasOwn(parsed.environment, "NODE_ENV"), false);
  const o = { ...objective(), matrixAuthoritySha256: a.digest };
  assertReviewContractAgreement(o, a, { ticket: o.ticket, repository: a.matrix.repository, approval: approval(o) });
});
const invalidLauncherCases = [
  ["extra launcher NODE_ENV", '"TZ":{"literal":"UTC"}', '"TZ":{"literal":"UTC"},"NODE_ENV":{"literal":"test"}', "REVIEW_FIELD"],
  ["launcher-name prefix collision TZ_EXTRA", '"TZ":{"literal":"UTC"}', '"TZ":{"literal":"UTC"},"TZ_EXTRA":{"literal":"UTC"}', "REVIEW_FIELD"],
  ["missing required launcher TZ", ',"TZ":{"literal":"UTC"}', "", "REVIEW_FIELD"],
  ["decoded duplicate launcher TZ", '"TZ":{"literal":"UTC"}', '"TZ":{"literal":"UTC"},"\\u0054Z":{"literal":"UTC"}', "REVIEW_DUPLICATE_KEY"],
  ["wrong launcher binding", '"PA_REPO":{"binding":"worktreeRoot"}', '"PA_REPO":{"binding":"featureSha"}', "REVIEW_FIELD"],
  ["literal replaced by binding", '"TZ":{"literal":"UTC"}', '"TZ":{"binding":"trustedPath"}', "REVIEW_FIELD"],
  ["mixed binding and literal declaration", '"TZ":{"literal":"UTC"}', '"TZ":{"literal":"UTC","binding":"trustedPath"}', "REVIEW_FIELD"],
  ["empty launcher literal", '"TZ":{"literal":"UTC"}', '"TZ":{"literal":""}', "REVIEW_FIELD"],
  ["malformed empty launcher declaration", '"TZ":{"literal":"UTC"}', '"TZ":{}', "REVIEW_FIELD"],
] as const;
for (const [name, from, to, code] of invalidLauncherCases) test(`parser/artifact reject ${name} despite opaque inline assignments`, () => {
  const m = artifact().matrix; m.commands[0]!.command = inlineCommandCases[0][1];
  const payload = JSON.stringify(m); assert.ok(payload.includes(from));
  const invalid = payload.replace(from, to);
  rejects(() => parseReviewMatrix(invalid), code);
  rejects(() => parseReviewMatrixArtifact(artifactWithPayload(invalid), m.source), code);
});

test("observational schema inspectors aggregate independent fields without partial authority", () => {
  const o = objective();
  assert.equal(parseReviewObjective(JSON.stringify({ ...o, ticket: "ALT-7", branch: "feature/ALT-7-generic" })).ticket, "ALT-7");
  const bad = inspectReviewObjective(JSON.stringify({ ...o, ticket: "x".repeat(65), branch: "develop", featureSha: "BAD" }));
  assert.equal(bad.objective, undefined); assert.equal(bad.errors.length, 3);
  const m = artifact().matrix;
  m.commands[0]!.cwd = "../escape"; m.commands[0]!.timeoutSeconds = 0; m.commands[0]!.maxOutputBytes = 1;
  m.passCriteria.critical = 1 as 0;
  assert.deepEqual(inspectReviewMatrix(JSON.stringify(m)).map((e) => e.diagnostic.source), ["matrix.commands[0].cwd", "matrix.commands[0].timeoutSeconds", "matrix.commands[0].maxOutputBytes", "matrix.passCriteria.critical"]);
});

test("strict objective fields, exact versions, identifiers, SHAs, digest and canonical UUIDv4", () => {
  const o = objective();
  for (const key of Object.keys(o)) {
    const r: Record<string, unknown> = { ...o }; delete r[key];
    rejects(() => parseReviewObjective(JSON.stringify(r)), key === "schemaVersion" ? "REVIEW_LEGACY_MIGRATION" : "REVIEW_FIELD");
  }
  const bad: Record<string, unknown[]> = {
    schemaVersion: ["pa-review-objective/v2", 1, null], ticket: ["fix-237", "FIX", 237],
    branch: ["develop", "feature/OTHER-237-isolated-review", "feature/FIX-237-a..b", "feature/FIX-237-a.lock"],
    featureSha: ["b".repeat(39), "B".repeat(40), 123], matrixAuthoritySha256: ["d".repeat(63), "D".repeat(64)],
    matrixApprovalEvidence: ["comment", "c-123", null],
    reviewAuthorizationId: ["00000000-0000-4000-8000-000000000000", "review-auth:00000000-0000-1000-8000-000000000000", "review-auth:ABCDEF00-0000-4000-8000-000000000000", "review-auth:00000000-0000-4000-7000-000000000000"],
    prerequisiteEvidence: [[], null, { "paired-runtime-ready": 5 }, { "bad gate": o.matrixApprovalEvidence }],
  };
  for (const [key, values] of Object.entries(bad)) for (const value of values) rejects(() => parseReviewObjective(JSON.stringify({ ...o, [key]: value })));
  rejects(() => parseReviewObjective(JSON.stringify({ ...o, token: o.reviewAuthorizationId })), "REVIEW_FIELD", "objective");
});

test("duplicate JSON keys are rejected at all levels, including escaped equivalents and prototype names", () => {
  const o = JSON.stringify(objective());
  rejects(() => parseReviewObjective(o.replace('"ticket":', '"ticket":"FIX-237","ticket":')), "REVIEW_DUPLICATE_KEY", "objective.ticket");
  rejects(() => parseReviewObjective(o.replace('"ticket":', '"\\u0074icket":"FIX-237","ticket":')), "REVIEW_DUPLICATE_KEY", "objective.ticket");
  rejects(() => parseReviewObjective(o.replace('"paired-runtime-ready":', '"paired-runtime-ready":"c-20000101000000000","paired-runtime-ready":')), "REVIEW_DUPLICATE_KEY", "objective.prerequisiteEvidence.fields");
  const m = matrixJson();
  for (const [key, value] of [["root", '"/fixture/canonical"'], ["kind", '"platform"'], ["binding", '"worktreeRoot"'], ["timeoutSeconds", "1800"], ["completionPercent", "100"]]) {
    rejects(() => parseReviewMatrix(m.replace(`"${key}":`, `"${key}":${value},"${key}":`)), "REVIEW_DUPLICATE_KEY");
  }
  rejects(() => parseReviewObjective(o.replace('"schemaVersion":', '"__proto__":{},"__proto__":{},"schemaVersion":')), "REVIEW_DUPLICATE_KEY");
  rejects(() => parseReviewObjective(o.replace('"schemaVersion":', '"__proto__":{},"schemaVersion":')), "REVIEW_FIELD");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("malformed JSON, UTF-8, Unicode escapes, BOM and excessive nesting reject deterministically", () => {
  for (const value of ['{"schemaVersion":', '{"a":1,}', '{"a":NaN}', '{"a":01}', '{"a":"\\x"}', '{"a":"\\ud800"}', '{"a":true} trailing', '{"a":"literal\nnewline"}']) rejects(() => parseReviewObjective(value), "REVIEW_JSON");
  rejects(() => parseReviewObjective('{"a":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}'), "REVIEW_JSON");
  rejects(() => parseReviewObjective(Buffer.from([0x7b, 0xc0, 0xaf, 0x7d])), "REVIEW_UTF8");
  rejects(() => parseReviewObjective("\ud800"), "REVIEW_UTF8");
  rejects(() => parseReviewObjective(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture(`${names[0]}.objective.json`)])), "REVIEW_UTF8");
  rejects(() => parseReviewMatrixArtifact(Buffer.from([0xff]), objective().matrixSource), "REVIEW_UTF8");
  rejects(() => parseReviewMatrix(Buffer.from([0xff])), "REVIEW_UTF8");
});

test("unknown nested fields and invalid matrix types cannot bypass the shared contract", () => {
  const cases: Array<(m: ReviewMatrix) => void> = [
    (m) => Object.assign(m, { extra: true }), (m) => Object.assign(m.repository, { extra: true }),
    (m) => Object.assign(m.prerequisites[0]!, { extra: true }), (m) => Object.assign(m.prerequisites[1]!, { extra: true }),
    (m) => Object.assign(m.prerequisites.find((p) => p.kind === "dependency")!, { extra: true }),
    (m) => Object.assign(m.prerequisites.find((p) => p.kind === "operatorGate")!, { extra: true }),
    (m) => Object.assign(m.environment.PA_REPO!, { literal: "/fixture/wrong" }),
    (m) => Object.assign(m.environment.CI!, { binding: "trustedPath" }),
    (m) => Object.assign(m.environment, { EXTRA: { literal: "1" } }),
    (m) => Object.assign(m.commands[0]!, { artifacts: [] }), (m) => Object.assign(m.passCriteria, { extra: true }),
    (m) => Object.assign(m, { commands: null }), (m) => Object.assign(m, { commandCount: "1" }),
    (m) => Object.assign(m, { outputs: {} }), (m) => Object.assign(m, { repository: [] }),
    (m) => Object.assign(m, { environment: false }), (m) => Object.assign(m, { prerequisites: {} }),
    (m) => Object.assign(m.commands[0]!, { command: "\0" }), (m) => Object.assign(m.commands[0]!, { command: 1 }),
    (m) => Object.assign(m.commands[0]!, { timeoutSeconds: 1801 }),
    (m) => Object.assign(m.commands[0]!, { timeoutSeconds: 0 }),
    (m) => Object.assign(m.commands[0]!, { maxOutputBytes: 1_048_575 }),
    (m) => Object.assign(m.commands[0]!, { maxOutputBytes: 1_073_741_825 }),
    (m) => Object.assign(m.commands[0]!, { cwd: "../escape" }),
    (m) => Object.assign(m.commands[0]!, { id: "bad id" }),
    (m) => Object.assign(m.passCriteria, { completionPercent: 99 }),
    (m) => Object.assign(m.passCriteria, { exitCode: 1 }), (m) => Object.assign(m.passCriteria, { critical: 1 }),
    (m) => Object.assign(m.passCriteria, { major: 1 }), (m) => Object.assign(m.passCriteria, { minorRationaleRequired: false }),
    (m) => Object.assign(m.environment.PA_REPO!, { binding: "canonicalRoot" }),
  ];
  for (const mutate of cases) { const m = artifact().matrix; mutate(m); rejects(() => parseReviewMatrix(JSON.stringify(m))); }
  for (const key of Object.keys(artifact().matrix)) {
    const missing = artifact().matrix as unknown as Record<string, unknown>; delete missing[key];
    rejects(() => parseReviewMatrix(JSON.stringify(missing)), key === "schemaVersion" ? "REVIEW_LEGACY_MIGRATION" : "REVIEW_FIELD");
  }
  for (const [field, value] of [["baseSha", "A".repeat(40)], ["root", "/fixture/../other"], ["key", "Fixture"], ["branch", "develop"]]) {
    const m = artifact().matrix; Object.assign(m.repository, { [field]: value });
    rejects(() => parseReviewMatrix(JSON.stringify(m)));
  }
  rejects(() => parseReviewMatrix(matrixJson().replace("pa-review-matrix/v1", "pa-review-matrix/v2")), "REVIEW_VERSION");
  const missingVersion = artifact().matrix as unknown as Record<string, unknown>; delete missingVersion.schemaVersion;
  rejects(() => parseReviewMatrix(JSON.stringify(missingVersion)), "REVIEW_LEGACY_MIGRATION");
});

test("profiles require explicit exact tools/platform and contained dependencies, never arbitrary probes", () => {
  const mutations: Array<(m: ReviewMatrix) => void> = [
    (m) => Object.assign(m, { profile: "unknown/v1" }),
    (m) => Object.assign(m.prerequisites[1]!, { name: "docker", probe: "touch authority" }),
    (m) => Object.assign(m.prerequisites[1]!, { name: "unsupported" }),
    (m) => Object.assign(m.prerequisites[1]!, { version: "v22\nv23" }),
    (m) => Object.assign(m.prerequisites[0]!, { kind: "script", command: "touch authority" }),
    (m) => { m.prerequisites = m.prerequisites.filter((p) => p.kind !== "platform"); },
    (m) => { m.prerequisites = m.prerequisites.filter((p) => p.kind !== "tool" || p.name !== "pnpm"); },
    (m) => { m.prerequisites.push(m.prerequisites[0]!); },
    (m) => Object.assign(m.prerequisites.find((p) => p.kind === "dependency")!, { root: "/other" }),
    (m) => Object.assign(m.prerequisites.find((p) => p.kind === "dependency")!, { name: "../package" }),
    (m) => Object.assign(m.prerequisites.find((p) => p.kind === "dependency")!, { version: "^4.0.0" }),
  ];
  for (const mutate of mutations) { const m = artifact().matrix; mutate(m); rejects(() => parseReviewMatrix(JSON.stringify(m))); }
  const nonNode = artifact("nx-055-migrated").matrix;
  nonNode.prerequisites.push({ kind: "dependency", root: ".", name: "tsx", version: "4.21.0" });
  rejects(() => parseReviewMatrix(JSON.stringify(nonNode)), "REVIEW_PROFILE");
  nonNode.prerequisites.pop(); nonNode.prerequisites.push({ kind: "tool", name: "node", version: "v22.23.2" });
  rejects(() => parseReviewMatrix(JSON.stringify(nonNode)), "REVIEW_PROFILE");
});

test("objective/artifact byte limits and 1000 ordered commands reject oversize rather than truncate", () => {
  const json = JSON.stringify(objective());
  const padded = json + " ".repeat(MAX_REVIEW_OBJECTIVE_BYTES - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(padded), MAX_REVIEW_OBJECTIVE_BYTES); parseReviewObjective(padded);
  rejects(() => parseReviewObjective(padded + " "), "REVIEW_SIZE");
  rejects(() => parseReviewObjective(json + "é".repeat(MAX_REVIEW_OBJECTIVE_BYTES / 2)), "REVIEW_SIZE");
  const raw = fixture(`${names[0]}.md`);
  parseReviewMatrixArtifact(Buffer.concat([raw, Buffer.alloc(MAX_REVIEW_ARTIFACT_BYTES - raw.length, 32)]), objective().matrixSource);
  rejects(() => parseReviewMatrixArtifact(Buffer.alloc(MAX_REVIEW_ARTIFACT_BYTES + 1), objective().matrixSource), "REVIEW_SIZE");
  const m = artifact().matrix; const first = m.commands[0]!;
  m.commands = Array.from({ length: 1000 }, (_, i) => ({ ...first, id: `command-${i}` }));
  m.commandCount = 1000; m.outputs = m.commands.map((c) => `${c.id}: output`);
  assert.equal(parseReviewMatrix(JSON.stringify(m)).commands.length, 1000);
  m.commands.push({ ...first, id: "command-1000" }); m.commandCount++; m.outputs.push("command-1000: output");
  rejects(() => parseReviewMatrix(JSON.stringify(m)), "REVIEW_FIELD", "matrix.commands");
  const bad = artifact().matrix; bad.commandCount = 2;
  rejects(() => parseReviewMatrix(JSON.stringify(bad)), "REVIEW_FIELD", "matrix.commandCount");
  bad.commandCount = 1; bad.outputs = ["other: output"];
  rejects(() => parseReviewMatrix(JSON.stringify(bad)), "REVIEW_FIELD", "matrix.outputs");
  bad.commands.push({ ...bad.commands[0]! }); bad.commandCount = 2;
  rejects(() => parseReviewMatrix(JSON.stringify(bad)), "REVIEW_FIELD", "matrix.commands");
});

test("raw section boundaries hash LF/CRLF and Unicode exactly, excluding next level-1-to-3 heading", () => {
  const raw = fixture(`${names[0]}.md`); const source = objective().matrixSource;
  const a = parseReviewMatrixArtifact(raw, source);
  assert.ok(Buffer.from(a.authorityBytes).toString().startsWith("### Full Validation Matrix\n"));
  assert.ok(!Buffer.from(a.authorityBytes).toString().includes("## After Matrix"));
  const start = raw.indexOf(Buffer.from("### Full Validation Matrix")); const end = raw.indexOf(Buffer.from("## After Matrix"));
  assert.deepEqual(Buffer.from(a.authorityBytes), raw.subarray(start, end));
  const crlf = Buffer.from(raw.toString().replace(/\n/g, "\r\n")); const c = parseReviewMatrixArtifact(crlf, source);
  assert.equal(c.digest, digest(crlf.subarray(crlf.indexOf("### Full Validation Matrix"), crlf.indexOf("## After Matrix"))));
  assert.notEqual(c.digest, a.digest); assert.deepEqual(c.matrix, a.matrix);
  for (const level of ["#", "##", "###"]) {
    const changed = Buffer.from(raw.toString().replace("## After Matrix", `${level} After Matrix`));
    assert.equal(parseReviewMatrixArtifact(changed, source).digest, a.digest);
  }
  const trailing = Buffer.concat([raw, Buffer.from("not authority\n")]); assert.equal(parseReviewMatrixArtifact(trailing, source).digest, a.digest);
  const internal = Buffer.from(raw.toString().replace("Policy: parser", "#### Not a boundary\n\nPolicy: parser"));
  assert.notEqual(parseReviewMatrixArtifact(internal, source).digest, a.digest);
  // Explicit synthetic CRLF reapproval tuple; no real approval/artifact is rewritten.
  const o = { ...objective(), matrixAuthoritySha256: c.digest };
  const changedHeader = Buffer.from(crlf.toString().replace(a.digest, c.digest));
  const migrated = parseReviewMatrixArtifact(changedHeader, source);
  assertReviewContractAgreement(o, migrated, { ticket: o.ticket, repository: c.matrix.repository, approval: approval(o) });
});

test("ambiguous headings, fences, missing boundaries and source/header aliases are rejected", () => {
  const raw = fixture(`${names[0]}.md`).toString(); const source = objective().matrixSource;
  const invalid: Array<[string, ReviewContractErrorCode]> = [
    [raw.replace("## After Matrix", "no terminal heading"), "REVIEW_BOUNDARY"],
    [raw + "### Full Validation Matrix\n", "REVIEW_BOUNDARY"],
    [raw.replace("### Full Validation Matrix", "## Full Validation Matrix"), "REVIEW_BOUNDARY"],
    [raw.replace("### Full Validation Matrix", "#### Full Validation Matrix"), "REVIEW_BOUNDARY"],
    [raw.replace("### Full Validation Matrix", "### Full Validation Matrix ###"), "REVIEW_BOUNDARY"],
    [raw.replace("```json", "```JSON"), "REVIEW_FENCE"],
    [raw.replace("```json", "~~~json").replace("\n```\n", "\n~~~\n"), "REVIEW_FENCE"],
    [raw.replace("Policy: parser", "```json\n{}\n```\nPolicy: parser"), "REVIEW_FENCE"],
    [raw.replace("\n```\n", "\n"), "REVIEW_FENCE"],
    [raw.replace("```json", "```json\n### Full Validation Matrix"), "REVIEW_BOUNDARY"],
    [raw.replace(`Matrix Source: ${source}`, `Matrix Source: ${source} `), "REVIEW_BINDING"],
    [raw.replace(`Matrix Source: ${source}`, `Matrix Source: ${source}\nMatrix Source: ${source}`), "REVIEW_BINDING"],
    [raw.replace("> Ticket: FIX-237", "> Ticket: FIX-237\n> Ticket: FIX-237"), "REVIEW_FIELD"],
    [raw.replace("> Ticket: FIX-237", "> Ticket: FIX-237\n> **Ticket:** FIX-237"), "REVIEW_FIELD"],
    [raw.replace(`Matrix Source: ${source}`, `Matrix Source: ${source}\n**Matrix Source:** ${source}`), "REVIEW_BINDING"],
    [raw.replace("comment c-20000101000000000 by sinh", "comment c-20000101000000000 by other"), "REVIEW_FIELD"],
    [raw.replace("comment c-20000101000000000 by sinh", "comment c-20000101000000000 by sinh-other"), "REVIEW_FIELD"],
    [raw.replace("names the exact Matrix Source and digest", "c-20000101000000001 names the exact source"), "REVIEW_FIELD"],
  ];
  for (const [value, code] of invalid) rejects(() => parseReviewMatrixArtifact(Buffer.from(value), source), code);
  // An unrelated fenced heading is not an authority boundary.
  const before = raw.replace("### Full Validation Matrix", "```md\n## Example\n```\n\n### Full Validation Matrix");
  assert.equal(parseReviewMatrixArtifact(Buffer.from(before), source).digest, artifact().digest);
});

test("agreement rejects every mismatched header/objective/approval/ticket/repository/gate identity", () => {
  const o = objective(); const a = artifact(); const expected = { ticket: o.ticket, repository: a.matrix.repository, approval: approval(o) };
  for (const [field, value] of [["ticket", "OTHER-237"], ["branch", "feature/FIX-237-other"], ["matrixSource", o.matrixSource + ".md"], ["matrixAuthoritySha256", "d".repeat(64)], ["matrixApprovalEvidence", "c-20000101000000001"]]) {
    rejects(() => assertReviewContractAgreement({ ...o, [field]: value }, a, expected), "REVIEW_BINDING");
  }
  for (const field of ["ticket", "repositoryKey", "repositoryRoot", "approvedBaseSha", "featureBranch", "matrixAuthoritySha256", "matrixApprovalEvidence"] as const) {
    rejects(() => assertReviewContractAgreement(o, { ...a, header: { ...a.header, [field]: "wrong" } }, expected), "REVIEW_BINDING");
  }
  for (const field of ["author", "commentId", "ticket", "branch", "matrixSource", "matrixAuthoritySha256"]) {
    rejects(() => assertReviewContractAgreement(o, a, { ...expected, approval: { ...expected.approval, [field]: "wrong" } }), "REVIEW_BINDING");
  }
  for (const field of ["key", "root", "baseSha", "branch"]) rejects(() => assertReviewContractAgreement(o, a, { ...expected, repository: { ...expected.repository, [field]: "wrong" } }), "REVIEW_BINDING");
  for (const evidence of [{}, { extra: o.matrixApprovalEvidence }, { ...o.prerequisiteEvidence, extra: o.matrixApprovalEvidence }]) {
    rejects(() => assertReviewContractAgreement({ ...o, prerequisiteEvidence: evidence }, a, expected), "REVIEW_BINDING");
  }
  a.matrix.prerequisites.find((p) => p.kind === "operatorGate")!.ticket = "OTHER-237";
  rejects(() => assertReviewContractAgreement(o, a, expected), "REVIEW_BINDING");
});

test("legacy incident copies reject with actionable migration diagnostics; no historical adoption", () => {
  const before = snapshot(fixtures);
  for (const name of ["mvm-179", "nx-055", "mvm-181", "pap-234", "dg-438", "pap-240"]) {
    rejects(() => parseReviewMatrixArtifact(fixture(`${name}-legacy.md`), `requirements:agent-teams/requirements/artifacts/fixture-${name}-legacy.md`), "REVIEW_LEGACY_MIGRATION");
  }
  const e = rejects(() => parseReviewObjective(fixture("legacy-objective.md")), "REVIEW_LEGACY_MIGRATION");
  assert.ok(e.diagnostic.correction.includes("new versioned requirements artifact"));
  assert.ok(e.diagnostic.correction.includes("preserve historical artifacts and accounting"));
  assert.deepEqual(snapshot(fixtures), before);
});

test("readiness binding is strictly typed but never authenticates provenance or integration completion", () => {
  const r = parseReviewReadinessBinding(fixture("readiness.json")); assert.equal(r.ticket, "FIX-237");
  for (const field of Object.keys(r)) {
    const bad: Record<string, unknown> = { ...r }; delete bad[field];
    rejects(() => parseReviewReadinessBinding(JSON.stringify(bad)), "REVIEW_FIELD");
  }
  rejects(() => parseReviewReadinessBinding(JSON.stringify({ ...r, installedRuntime: { ...r.installedRuntime, extra: true } })), "REVIEW_FIELD");
  rejects(() => parseReviewReadinessBinding(JSON.stringify({ ...r, installedRuntime: { ...r.installedRuntime, binary: "/bin/ppa" } })), "REVIEW_FIELD");
  rejects(() => parseReviewReadinessBinding(JSON.stringify({ ...r, featureSha: "B".repeat(40) })), "REVIEW_FIELD");
  rejects(() => parseReviewReadinessBinding(JSON.stringify({ ...r, mergedConfigSha: "c".repeat(39) })), "REVIEW_FIELD");
  rejects(() => parseReviewReadinessBinding(JSON.stringify({ ...r, extra: true })), "REVIEW_FIELD");
});

test("protected source rejects wrong prefix, absolute/traversal/alias paths without filesystem probes", (t) => {
  const source = objective().matrixSource;
  const probe = t.mock.method(fs, "lstatSync", () => { throw new Error("unexpected probe"); }); syncBuiltinESMExports();
  try {
    for (const bad of [source.slice("requirements:".length), "implementation:agent-teams/requirements/artifacts/x.md", "requirements:/tmp/x.md", "requirements:agent-teams/requirements/artifacts/../x.md", "requirements:agent-teams/requirements/artifacts/./x.md", "requirements:agent-teams/requirements/artifacts//x.md", "requirements:agent-teams/requirements/artifacts/..\\x.md", "requirements:agent-teams/requirements/artifacts/C:/x.md", "requirements:agent-teams/requirements/artifacts/x.txt", source + " "]) {
      rejects(() => readReviewMatrixArtifact("/fixture/absent", bad));
    }
    assert.equal(probe.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(parseReviewMatrixSource(source), source);
});

test("bounded regular-file readers reject symlink leaves/ancestors/roots, directories, FIFO, absence and oversize", () => {
  temporary((root) => {
    const path = installArtifact(root); const o = objective();
    assert.equal(readReviewMatrixArtifact(root, o.matrixSource).digest, o.matrixAuthoritySha256);
    const objectivePath = join(root, "objective.json"); fs.writeFileSync(objectivePath, fixture(`${names[0]}.objective.json`));
    assert.deepEqual(readReviewObjectiveFile(objectivePath), o);
    const alias = join(root, "alias.json"); fs.symlinkSync(objectivePath, alias);
    rejects(() => readReviewObjectiveFile(alias), "REVIEW_SOURCE");
    const rootAlias = join(root, "root-alias"); fs.symlinkSync(root, rootAlias);
    rejects(() => readReviewMatrixArtifact(rootAlias, o.matrixSource), "REVIEW_SOURCE");
    const real = path + ".real"; fs.renameSync(path, real); fs.symlinkSync(real, path);
    rejects(() => readReviewMatrixArtifact(root, o.matrixSource), "REVIEW_SOURCE"); fs.unlinkSync(path); fs.renameSync(real, path);
    const directory = dirname(path); fs.renameSync(directory, directory + "-real"); fs.symlinkSync(directory + "-real", directory);
    rejects(() => readReviewMatrixArtifact(root, o.matrixSource), "REVIEW_SOURCE"); fs.unlinkSync(directory); fs.renameSync(directory + "-real", directory);
    fs.unlinkSync(path); fs.mkdirSync(path); rejects(() => readReviewMatrixArtifact(root, o.matrixSource), "REVIEW_SOURCE"); fs.rmdirSync(path);
    const fifo = childProcess.spawnSync("mkfifo", [path]); assert.equal(fifo.status, 0, fifo.stderr.toString());
    rejects(() => readReviewMatrixArtifact(root, o.matrixSource), "REVIEW_SOURCE"); fs.unlinkSync(path);
    fs.writeFileSync(path, Buffer.alloc(MAX_REVIEW_ARTIFACT_BYTES + 1)); rejects(() => readReviewMatrixArtifact(root, o.matrixSource), "REVIEW_SIZE");
    fs.writeFileSync(objectivePath, Buffer.alloc(MAX_REVIEW_OBJECTIVE_BYTES + 1)); rejects(() => readReviewObjectiveFile(objectivePath), "REVIEW_SIZE");
    fs.unlinkSync(path); rejects(() => readReviewMatrixArtifact(root, o.matrixSource), "REVIEW_IO");
    rejects(() => readReviewMatrixArtifact(join(root, "missing-root"), o.matrixSource), "REVIEW_IO");
  });
});

test("diagnostics are stable, bounded, field-specific and disclose no authorization even in unknown keys", () => {
  const o = objective(); const raw = JSON.stringify({ ...o, featureSha: "INVALID", [o.reviewAuthorizationId]: o.reviewAuthorizationId });
  const first = rejects(() => parseReviewObjective(raw)); const second = rejects(() => parseReviewObjective(raw));
  assert.equal(formatReviewContractDiagnostic(first), formatReviewContractDiagnostic(second));
  const nested = matrixJson().replace('"binding":', `"${o.reviewAuthorizationId}":1,"${o.reviewAuthorizationId}":2,"binding":`);
  const error = rejects(() => parseReviewMatrix(nested), "REVIEW_DUPLICATE_KEY");
  assert.ok(!JSON.stringify(error.diagnostic).includes(o.reviewAuthorizationId));
});

test("parser/read APIs are observational: zero writes, subprocesses, network, claims, allocations or accounting", (t) => {
  temporary((root) => {
    const path = installArtifact(root); const o = objective(); const objectivePath = join(root, "objective.json");
    fs.writeFileSync(objectivePath, fixture(`${names[0]}.objective.json`));
    const before = snapshot(root);
    const readinessBytes = fixture("readiness.json");
    const forbidden = (): never => { throw new Error("forbidden static side effect"); };
    const traps = [
      t.mock.method(fs, "writeFileSync", forbidden), t.mock.method(fs, "appendFileSync", forbidden),
      t.mock.method(fs, "mkdirSync", forbidden), t.mock.method(fs, "renameSync", forbidden),
      t.mock.method(fs, "unlinkSync", forbidden), t.mock.method(fs, "rmSync", forbidden),
      t.mock.method(fs, "chmodSync", forbidden), t.mock.method(fs, "truncateSync", forbidden),
      t.mock.method(fs, "writeSync", forbidden), t.mock.method(fs, "createWriteStream", forbidden),
      t.mock.method(fs.promises, "writeFile", forbidden), t.mock.method(fs.promises, "mkdir", forbidden),
      t.mock.method(childProcess, "spawn", forbidden), t.mock.method(childProcess, "spawnSync", forbidden),
      t.mock.method(childProcess, "exec", forbidden), t.mock.method(childProcess, "execSync", forbidden),
      t.mock.method(childProcess, "execFile", forbidden), t.mock.method(childProcess, "execFileSync", forbidden),
      t.mock.method(childProcess, "fork", forbidden), t.mock.method(net, "connect", forbidden),
      t.mock.method(net, "createConnection", forbidden), t.mock.method(http, "request", forbidden),
      t.mock.method(http, "get", forbidden), t.mock.method(https, "request", forbidden), t.mock.method(https, "get", forbidden),
      t.mock.method(globalThis, "fetch", forbidden),
    ];
    const open = fs.openSync;
    const opens = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      assert.equal(typeof args[1], "number");
      assert.equal((args[1] as number) & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND), 0);
      return open(...args);
    });
    syncBuiltinESMExports();
    try {
      const a = readReviewMatrixArtifact(root, o.matrixSource); const parsed = readReviewObjectiveFile(objectivePath);
      assertReviewContractAgreement(parsed, a, { ticket: o.ticket, repository: a.matrix.repository, approval: approval(o) });
      parseReviewReadinessBinding(readinessBytes);
      rejects(() => readReviewMatrixArtifact(join(root, "absent-state"), o.matrixSource), "REVIEW_IO");
      rejects(() => readReviewObjectiveFile(join(root, "absent-objective")), "REVIEW_IO");
      for (const trap of traps) assert.equal(trap.mock.callCount(), 0);
      assert.equal(opens.mock.callCount(), 2);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.deepEqual(snapshot(root), before); assert.ok(fs.existsSync(path)); assert.ok(!fs.existsSync(join(root, "absent-state")));
  });
});
