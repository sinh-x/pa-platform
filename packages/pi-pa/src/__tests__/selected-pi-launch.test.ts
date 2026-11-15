import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSelectedPiResumeHost, matchesSelectedPiResumeRecord, recordSelectedPiLaunch } from "../selected-pi-resume.js";
import { parseSelectedPiLaunch, resolveSelectedPiLaunch, selectedPiEnvironment } from "../selected-pi-launch.js";

const own = "/nix/store/00000000000000000000000000000000-inert-pa-platform";
const share = `${own}/share/pa-platform`;
const addonFile = `${share}/native-addons/pi-node-24/better_sqlite3.node`;
const record = () => ({ schemaVersion: 1, entryFile: `${own}/bin/.ppa-selected-pi`,
  nodeFile: "/nix/store/11111111111111111111111111111111-inert-node/bin/node",
  packageRoot: "/nix/store/22222222222222222222222222222222-inert-pi/lib/node_modules/pi-monorepo",
  addonFile, environmentNames: ["HOME", "PATH", "OPENAI_API_KEY", "PI_OFFLINE", "PA_SQLITE_NATIVE_BINDING", "PA_PI_SQLITE_NATIVE_BINDING", "PA_REQUIRE_PI_SQLITE_NATIVE_BINDING"] });

// These are pure grammar fixtures, not immutable build or source-read grants.
test("selected launch grammar accepts only its finite native-build shape", () => {
  const parsed = parseSelectedPiLaunch(record(), share);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.environmentNames), true);
  for (const mutation of [
    { schemaVersion: 2 }, { entryFile: "/tmp/pi" }, { addonFile: "/tmp/addon.node" },
    { nodeFile: "/tmp/node" }, { nodeFile: `${own}/bin/../bin/node` },
    { packageRoot: `${own}/lib/node_modules/other` }, { root: "/tmp/forged-root" },
    { environmentNames: ["HOME", "HOME"] }, { environmentNames: ["NODE_OPTIONS"] },
    { environmentNames: ["OPENSSL_CONF"] }, { environmentNames: ["LD_PRELOAD"] },
    { environmentNames: ["PI_PACKAGE_DIR"] }, { environmentNames: ["PA_PI_START_NODE_OPTIONS"] },
  ]) assert.throws(() => parseSelectedPiLaunch({ ...record(), ...mutation }, share));
  for (const value of [null, [], "claimed-build", {}, { ...record(), environmentNames: [] }])
    assert.throws(() => parseSelectedPiLaunch(value, share));
});

test("selected child environment is finite, preserves provider values privately and rejects startup code hooks", () => {
  const selected = parseSelectedPiLaunch(record(), share);
  const env = selectedPiEnvironment(selected, { HOME: "/tmp/inert-home", OPENAI_API_KEY: "inert", PI_OFFLINE: "1", UNREVIEWED_VARIABLE: "not-forwarded" });
  assert.equal(env.HOME, "/tmp/inert-home");
  assert.equal(env.OPENAI_API_KEY, "inert");
  assert.equal(env.UNREVIEWED_VARIABLE, undefined);
  assert.equal(env.PA_SQLITE_NATIVE_BINDING, addonFile);
  assert.equal(env.PA_PI_SQLITE_NATIVE_BINDING, addonFile);
  for (const name of ["NODE_OPTIONS", "OPENSSL_CONF", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "GCONV_PATH", "GLIBC_TUNABLES", "PI_PACKAGE_DIR", "PA_PI_START_NODE_OPTIONS", "PA_PI_PARENT_LEASE_TOKEN"]) {
    for (const value of ["", "INERT_PRIVATE_STARTUP_VALUE"]) assert.throws(() => selectedPiEnvironment(selected, { [name]: value }), error =>
      error instanceof Error && !error.message.includes("INERT_PRIVATE_STARTUP_VALUE") && error.message.length <= 2000);
  }
  assert.throws(() => selectedPiEnvironment(selected, { PA_SQLITE_NATIVE_BINDING: "/tmp/foreign.node" }));
});

test("ordinary source runs cannot select a host through environment or a claimed root", () => {
  const environment = process.env;
  try {
    process.env = { ...environment, PA_PI_SELECTED_ROOT: own, PA_SELECTED_PI_LAUNCH: JSON.stringify(record()) };
    assert.equal(resolveSelectedPiLaunch(), undefined);
  } finally { process.env = environment; }
});

test("private selected-host launch observations are absent-only and cannot upgrade/downgrade a retained session", () => {
  const root = mkdtempSync(join(tmpdir(), "selected-resume-")), directory = join(root, "d-original");
  mkdirSync(directory, { mode: 0o700 });
  const selected = parseSelectedPiLaunch(record(), share);
  const path = join(directory, "pi-selected-host.json");
  try {
    assertSelectedPiResumeHost("d-legacy", "inert-session", root);
    assert.equal(existsSync(join(root, "d-legacy")), false, "legacy inspection never initializes a deployment");
    recordSelectedPiLaunch("d-original", "inert-session", selected, directory);
    const bytes = readFileSync(path, "utf8"), before = statSync(path, { bigint: true });
    assert.equal(before.mode & 0o777n, 0o600n); assert.equal(before.nlink, 1n);
    const stored = JSON.parse(bytes);
    assert.equal(matchesSelectedPiResumeRecord(stored, "d-original", "inert-session", selected), true);
    for (const mutation of [{ sessionId: "other-session" }, { deploymentId: "d-other" }, { entryFile: "/tmp/foreign" }, { extra: "not-native" }])
      assert.equal(matchesSelectedPiResumeRecord({ ...stored, ...mutation }, "d-original", "inert-session", selected), false);
    let getterCalled = false;
    const hostile = { ...stored }; Object.defineProperty(hostile, "sessionId", { enumerable: true, get() { getterCalled = true; return "inert-session"; } });
    assert.equal(matchesSelectedPiResumeRecord(hostile, "d-original", "inert-session", selected), false);
    assert.equal(getterCalled, false);
    recordSelectedPiLaunch("d-original", "inert-session", selected, directory);
    assert.equal(statSync(path, { bigint: true }).mtimeNs, before.mtimeNs, "unchanged launch observation is not rewritten");
    assert.throws(() => recordSelectedPiLaunch("d-original", "other-session", selected, directory));
    assert.equal(readFileSync(path, "utf8"), bytes);
    assert.deepEqual(readdirSync(directory), ["pi-selected-host.json"], "no partial temporary evidence remains");
    // This test process is an ordinary unselected source runtime. A retained
    // selected-host observation must not be silently downgraded through it.
    assert.throws(() => assertSelectedPiResumeHost("d-original", "inert-session", root));
    chmodSync(path, 0o644);
    assert.throws(() => recordSelectedPiLaunch("d-original", "inert-session", selected, directory));
    chmodSync(path, 0o600);
    const aliasDir = join(root, "d-alias"); mkdirSync(aliasDir);
    const alias = join(aliasDir, "pi-selected-host.json");
    symlinkSync(path, alias);
    assert.throws(() => assertSelectedPiResumeHost("d-alias", "inert-session", root));
    rmSync(alias); linkSync(path, alias);
    assert.throws(() => assertSelectedPiResumeHost("d-original", "inert-session", root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
