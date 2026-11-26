import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getSecurityDefaults, MAX_SECURITY_POLICY_BYTES, SecurityPolicyError, validateSecurityPolicy } from "../security-policy.js";
import { PA_SAFETY_PATTERNS } from "../safety-policy.js";
import { loadSensitivePatterns } from "../sensitive-patterns.js";

const bytes = readFileSync(new URL("../policies/security-defaults.v1.yaml", import.meta.url));
const fresh = () => JSON.parse(JSON.stringify(validateSecurityPolicy(bytes)), (key, value) => key === "sha256" ? undefined : value);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const reject = (value: Uint8Array) => assert.throws(() => validateSecurityPolicy(value), SecurityPolicyError);

test("owned defaults preserve exact baseline order, categories, flags, public shapes and labels", () => {
  const projection = { safety: PA_SAFETY_PATTERNS, sensitive: loadSensitivePatterns("/nonexistent-pap348-synthetic-config").patterns.map(p => [p.inputClass, p.source, p.regex.source, p.regex.flags]) };
  assert.equal(createHash("sha256").update(JSON.stringify(projection)).digest("hex"), "3b0be65dbcb8d677c3c396682267bf6547f181285559d987ad4d9989636f9e3b");
  assert.equal(getSecurityDefaults().sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("strict required schema rejects unknown/missing fields, versions, types and unsafe flags", () => {
  for (const mutate of [
    (p: any) => { p.unknown = true; }, (p: any) => { delete p.safety; },
    (p: any) => { p.schemaVersion = "future"; }, (p: any) => { p.sensitive = []; },
    (p: any) => { p.safety.destructiveCommands = []; }, (p: any) => { p.sensitive.paths = null; },
    (p: any) => { p.sensitive.paths[0].flags = "g"; }, (p: any) => { delete p.sensitive.paths[0].flags; },
    (p: any) => { p.safety.blockedFilePatterns[0].flags = ""; },
    (p: any) => { p.sensitive.paths[0].pattern = "["; }, (p: any) => { p.sensitive.paths[0].pattern = ""; },
    (p: any) => { p.sensitive.paths[0].pattern = 1; },
    (p: any) => { p.sensitive.paths.push({ ...p.sensitive.paths[0] }); },
    (p: any) => { p.sensitive.paths[0].action = "allow"; },
  ]) { const p = fresh(); mutate(p); reject(encode(p)); }
  for (const text of ["schemaVersion: x\nschemaVersion: y", "!!js/function 'function(){}'", "&a {schemaVersion: *a}", "[", "", "null"]) reject(Buffer.from(text));
  reject(Buffer.from([0xc0, 0xaf]));
});

test("byte, entry and pattern bounds include exact boundaries", () => {
  validateSecurityPolicy(Buffer.concat([bytes, Buffer.from("#" + "x".repeat(MAX_SECURITY_POLICY_BYTES - bytes.length - 1))]));
  reject(Buffer.alloc(MAX_SECURITY_POLICY_BYTES + 1, 32));
  const p = fresh(); p.sensitive.paths = [{ pattern: "x".repeat(4096), flags: "" }];
  validateSecurityPolicy(encode(p)); p.sensitive.paths[0].pattern += "x"; reject(encode(p));
  const many = fresh();
  const existing = Object.values(many.safety).concat(Object.values(many.sensitive)).reduce((n: number, v: any) => n + v.length, 0);
  for (let n = existing; n < 256; n++) many.sensitive.paths.push({ pattern: `inert-${n}`, flags: "" });
  validateSecurityPolicy(encode(many)); many.sensitive.paths.push({ pattern: "overflow", flags: "" }); reject(encode(many));
  const aliased = bytes.toString().replace("  paths:\n", "  paths: &shared\n").replace(/  contents:[\s\S]*$/, "  contents: *shared\n");
  reject(Buffer.from(aliased));
});

test("default cache is immutable data, while compatibility arrays and regexes are fresh", () => {
  assert.equal(getSecurityDefaults(), getSecurityDefaults());
  assert.throws(() => { (getSecurityDefaults().sensitive.paths[0] as any).pattern = "allow"; }, TypeError);
  PA_SAFETY_PATTERNS.destructiveCommands.splice(0);
  assert.ok(PA_SAFETY_PATTERNS.destructiveCommands.length);
  const first = loadSensitivePatterns("/nonexistent-pap348-synthetic-config");
  first.patterns[0]!.regex.compile("ordinary");
  assert.notEqual(loadSensitivePatterns("/nonexistent-pap348-synthetic-config").patterns[0]!.regex.source, "ordinary");
});

test("failure formatting is bounded, nonsecret and outcome uncertainty is explicit", () => {
  for (const category of ["unavailable", "invalid", "limit"] as const) {
    const output = new SecurityPolicyError(category).message;
    assert.ok(output.length <= 2000);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(output.split(label).length - 1, 1);
    assert.match(output, /execution state is not established/);
    assert.match(output, /Reconcile any possible prior effect/);
    assert.doesNotMatch(output, /node:|ENOENT|\.yaml|\/home\//);
  }
  for (const value of ["x".repeat(2000), "x".repeat(2001), "\u001b[31m\nReason: private", { toString() { throw new Error("untrusted coercion"); } }]) {
    assert.equal(new SecurityPolicyError(value as any).message, new SecurityPolicyError("unavailable").message);
  }
});
