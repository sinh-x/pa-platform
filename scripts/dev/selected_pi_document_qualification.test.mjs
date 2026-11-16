import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.env.PA_TEST_DOCUMENT_QUALIFICATION;
const node = process.env.PA_TEST_PI_NODE;
assert.ok(root && node, "fixed test-driver artifact inputs required; never runtime root overrides");
const entry = join(root, "bin/qualify-selected-documents"), bootstrap = join(root, "lib/doc-qualify.mjs");
const schema = "pa-selected-document-qualification/v1";
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "pap298-document-"));
  mkdirSync(join(directory, "project"), { mode: 0o700 });
  const env = { HOME: join(directory, "home"), PI_CODING_AGENT_DIR: join(directory, "agent"),
    XDG_CACHE_HOME: join(directory, "cache"), TMPDIR: directory, NO_COLOR: "1", TERM: "dumb" };
  const execute = (file = entry, args = [], extra = {}) => spawnSync(file, args, {
    cwd: join(directory, "project"), env: { ...env, ...extra }, encoding: "utf8", timeout: 45000,
    maxBuffer: 1024 * 1024, killSignal: "SIGKILL",
  });
  try { return run({ directory, execute }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
const events = result => result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
function denied(result, code = "SELECTED_HOST_ENTRY") {
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.equal(events(result).length, 0, "no fixture content/event before qualified execution");
  assert.match(result.stderr, new RegExp(code));
  assert.ok(result.stderr.length <= 2000);
  for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"])
    assert.equal(result.stderr.split(`${label}:`).length, 2);
}

const mappedRoot = statSync(bootstrap).uid === 0;
test(mappedRoot ? "real selected Pi native loader registers a guarded hard-link reader; inert positives/negatives reach the owned sink"
  : "unmapped store ownership explicitly denies document qualification", () => fixture(({ execute }) => {
  const result = execute();
  if (!mappedRoot) { denied(result, "SELECTED_HOST_ENTRY"); return; }
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const records = events(result), reads = records.filter(record => record.schema === schema);
  assert.equal(reads.length, 10);
  const byName = new Map(reads.map(record => [record.name, record.result]));
  for (const name of ["selected-readme", "selected-docs-redaction", "selected-example"]) assert.notEqual(byName.get(name)?.isError, true, name);
  assert.match(JSON.stringify(byName.get("selected-readme")), /PAP-298 inert selected documentation/);
  assert.match(JSON.stringify(byName.get("selected-docs-redaction")), /REDACTED/);
  assert.match(JSON.stringify(byName.get("selected-example")), /inert selected example/);
  for (const name of ["outside-scope", "hardlinked-image", "invalid-utf8", "symlink-route", "mutable-hardlink"])
    assert.equal(byName.get(name)?.details.code, "LOCAL_SOURCE_UNSUPPORTED_FILE", name);
  assert.equal(byName.get("protected-name")?.details.code, "LOCAL_SOURCE_BLOCKED");
  assert.equal(byName.get("revoked-before-native-sink")?.details.code, "LOCAL_SOURCE_UNAVAILABLE");
  assert.doesNotMatch(result.stdout, /INERT_DOCUMENT_CANARY|inert mutable alias body|GIF89aASCII/);
  assert.deepEqual(records.find(record => record.schema === "pa-selected-document-qualification-summary/v1"), {
    schema: "pa-selected-document-qualification-summary/v1", cases: 10, registeredReader: true, productionEnabled: false,
  });
  assert.match(result.stdout, /Usage:/i, "actual fixed Pi help completes, not a mocked host callback");
}));

test("direct Node cannot borrow native-parent custody from the immutable document producer", () => fixture(({ execute }) => {
  denied(execute(node, [bootstrap]), "LOCAL_SOURCE_UNAVAILABLE");
}));

test("document/root arguments and native startup claims cannot choose another read or host", () => fixture(({ execute }) => {
  denied(execute(entry, ["--root", "/nix/store/forged"]));
  for (const key of ["NODE_OPTIONS", "OPENSSL_CONF", "PI_PACKAGE_DIR", "PA_SELECTED_PI_ROOT", "UNREVIEWED_STARTUP_KEY"])
    denied(execute(entry, [], { [key]: "/inert/conflict" }));
}));

test("copied mutable native supervisor cannot acquire its original literal entry custody", () => fixture(({ directory, execute }) => {
  const copy = join(directory, "copied-entry");
  copyFileSync(entry, copy);
  denied(execute(copy));
}));
