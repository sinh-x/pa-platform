import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AXI_VERSIONS, axiRuntimeEnvironment, runManagedAxi, type AxiPolicyEffects, type AxiTool, type ManagedAxiInvocation } from "../axi-policy.js";
import { BROWSER_CLEANUP_MS, BROWSER_IDLE_MS, BROWSER_READINESS_MS, browserArgumentsAllowed, browserContext, browserLifecycleEnvironment, cleanupBrowserSession, cleanupManagedBrowser, managedMcpShim, ownedSessionProcesses, ownsListener, pinnedMcpArguments, processIdentity, runBrowserCommand, superviseBrowserLifetime, type BrowserProcessEffects, type ProcessIdentity } from "../axi-browser.js";
import { parseQuotaConsent, quotaProviderEnvironment, readQuotaConsent, readQuotaProfileExpired, runManagedQuota, sanitizeQuotaResult, validConsentFile, type QuotaEffects, type QuotaProvider } from "../axi-quota.js";
import { finishBrowserLifecycle } from "../adapter.js";

function fixture(tool: AxiTool, args: string[], env: NodeJS.ProcessEnv = {}) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const input: ManagedAxiInvocation = { tool, node: "/pinned/node", entrypoint: `/pinned/${tool}.js`, gh: "/pinned/gh", args, env };
  const effects: AxiPolicyEffects = {
    ghAuthenticated: () => { calls.push("gh-auth"); return false; },
    chromeExecutable: () => { calls.push("chrome-stat"); return false; },
    run: () => { calls.push("upstream"); return 0; },
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  };
  return { input, effects, calls, stdout, stderr };
}

test("all selected AXI tools provide help/version without auth, credentials, filesystem discovery or subprocesses", () => {
  for (const tool of Object.keys(AXI_VERSIONS) as AxiTool[]) {
    for (const arg of ["--help", "-h", "help", "--version", "-v", "-V", "version"]) {
      const f = fixture(tool, [arg], { GH_TOKEN: "secret-sentinel", PA_AXI_QUOTA_CONSENT: "/path-sentinel", PA_AXI_CHROME_EXECUTABLE: "/identity-sentinel" });
      assert.equal(runManagedAxi(f.input, f.effects), 0);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.stderr, []);
      assert.match(f.stdout.join(""), new RegExp(AXI_VERSIONS[tool].replaceAll(".", "\\.")));
      assert.doesNotMatch(f.stdout.join(""), /secret-sentinel|path-sentinel|identity-sentinel/);
    }
  }
});

test("missing GH authentication yields a named diagnostic and never runs upstream", () => {
  const f = fixture("gh-axi", ["pr", "list"]);
  assert.equal(runManagedAxi(f.input, f.effects), 1);
  assert.deepEqual(f.calls, ["gh-auth"]);
  assert.match(f.stderr.join(""), /^AXI_GH_AUTH_REQUIRED:/);
  assert.deepEqual(f.stdout, []);
  f.effects.ghAuthenticated = () => { throw new Error("token=secret-sentinel /path-sentinel identity-sentinel"); };
  assert.equal(runManagedAxi(f.input, f.effects), 1);
  assert.doesNotMatch(f.stderr.join(""), /secret-sentinel|path-sentinel|identity-sentinel/);
});

test("explicit authenticated GH operation uses pinned entrypoint/host, preserves exit status and grants no approval", () => {
  const f = fixture("gh-axi", ["pr", "list", "--hostname=git.example.test"], { GH_TOKEN: "synthetic" });
  f.effects.ghAuthenticated = (exe, host, env) => {
    assert.equal(exe, "/pinned/gh");
    assert.equal(host, "git.example.test");
    assert.equal(env["GH_HOST"], host);
    assert.equal(env["GH_PROMPT_DISABLED"], "1");
    return true;
  };
  f.effects.run = (node, args, env) => {
    assert.equal(node, "/pinned/node");
    assert.deepEqual(args, ["/pinned/gh-axi.js", ...f.input.args]);
    assert.equal(env["GH_NO_UPDATE_NOTIFIER"], "1");
    assert.equal(env["PA_APPROVED"], undefined);
    return 17;
  };
  assert.equal(runManagedAxi(f.input, f.effects), 17);
  assert.deepEqual(f.stdout, []);
});

test("managed GH rejects global setup/hooks, bootstrap, update and malformed host before any action", () => {
  for (const args of [["setup", "hooks"], ["setup", "--help"], ["install"], ["self-update"], ["update"], ["--help", "pr", "merge"], ["api", "--hostname"], ["api", "--hostname=/secret-sentinel"]]) {
    const f = fixture("gh-axi", args);
    assert.equal(runManagedAxi(f.input, f.effects), 1);
    assert.deepEqual(f.calls, []);
    assert.match(f.stderr.join(""), /^AXI_POLICY_REJECTED:/);
    assert.doesNotMatch(f.stderr.join(""), /secret-sentinel/);
  }
});

test("missing, relative, inaccessible or exceptional Chrome prerequisite has a non-secret diagnostic", () => {
  for (const path of [undefined, "relative", "/path-sentinel"]) {
    const f = fixture("chrome-devtools-axi", ["open", "http://fixture.test"], { PA_AXI_CHROME_EXECUTABLE: path });
    assert.equal(runManagedAxi(f.input, f.effects), 1);
    assert.match(f.stderr.join(""), /^AXI_CHROME_REQUIRED:/);
    assert.doesNotMatch(f.stderr.join(""), /path-sentinel|fixture.test/);
    assert.deepEqual(f.calls, path === "/path-sentinel" ? ["chrome-stat"] : []);
  }
  const f = fixture("chrome-devtools-axi", ["start"], { PA_AXI_CHROME_EXECUTABLE: "/path-sentinel" });
  f.effects.chromeExecutable = () => { throw new Error("secret-sentinel"); };
  assert.equal(runManagedAxi(f.input, f.effects), 1);
  assert.match(f.stderr.join(""), /^AXI_CHROME_REQUIRED:/);
  assert.doesNotMatch(f.stderr.join(""), /secret-sentinel/);
});

test("present Chrome without the pinned MCP/lifecycle seam never produces placeholder operational success",  () => {
  for (const args of [["start"], ["navigate", "http://fixture.test"], ["--browser-url=http://foreign.test"], ["--profile=/foreign"], ["--help", "start"]]) {
    const f = fixture("chrome-devtools-axi", args, { PA_AXI_CHROME_EXECUTABLE: "/operator/chrome" });
    f.effects.chromeExecutable = () => true;
    assert.equal(runManagedAxi(f.input, f.effects), 1);
    assert.deepEqual(f.calls, []);
    assert.match(f.stderr.join(""), /^AXI_POLICY_REJECTED:/);
    assert.deepEqual(f.stdout, []);
  }
});

test("quota without consent performs zero credential reads/provider requests and reports the missing prerequisite", () => {
  const f = fixture("quota-axi", [], { CODEX_HOME: "/path-sentinel", CLAUDE_CONFIG_DIR: "/identity-sentinel", OPENAI_API_KEY: "secret-sentinel" });
  assert.equal(runManagedAxi(f.input, f.effects), 1);
  assert.deepEqual(f.calls, []);
  assert.match(f.stderr.join(""), /^AXI_QUOTA_CONSENT_REQUIRED:/);
  assert.doesNotMatch(f.stderr.join(""), /path-sentinel|identity-sentinel|secret-sentinel/);
  assert.deepEqual(f.stdout, []);
});

test("a consent path is not consent: all quota operations stay denied without reading that path", () => {
  for (const args of [[], ["quota"], ["--json"], ["refresh"], ["--tui"], ["--help", "--refresh"]]) {
    const f = fixture("quota-axi", args, { PA_AXI_QUOTA_CONSENT: "/does-not-exist/path-sentinel" });
    assert.equal(runManagedAxi(f.input, f.effects), 1);
    assert.deepEqual(f.calls, []);
    assert.match(f.stderr.join(""), /^AXI_POLICY_REJECTED:/);
    assert.doesNotMatch(f.stderr.join(""), /path-sentinel/);
  }
});

test("production managed CLI discards synthetic gh auth output and denies browser/quota without upstream execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "axi-policy-cli-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(gh, `#!${process.execPath}\nprocess.stdout.write('identity-sentinel'); process.stderr.write('secret-sentinel /path-sentinel'); process.exit(1);\n`);
    chmodSync(gh, 0o755);
    const tsx = fileURLToPath(new URL("../../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const policy = fileURLToPath(new URL("../axi-policy.ts", import.meta.url));
    for (const [tool, args, expected] of [
      ["gh-axi", ["pr", "list"], "AXI_GH_AUTH_REQUIRED"],
      ["chrome-devtools-axi", ["start"], "AXI_CHROME_REQUIRED"],
      ["quota-axi", ["--json"], "AXI_QUOTA_CONSENT_REQUIRED"],
    ] as const) {
      const result = spawnSync(process.execPath, [tsx, policy, tool, process.execPath, "/nonexistent/upstream.js", gh, "-", ...args], {
        env: { PATH: process.env["PATH"], HOME: dir }, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(`^${expected}:`));
      assert.doesNotMatch(result.stderr, /identity-sentinel|secret-sentinel|path-sentinel|upstream.js/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runtime PATH defaults off, preserves inherited host exposure and does not mutate the input", () => {
  const env = { PATH: "/host/gh-axi:/host/bin::", HOME: "/operator/home" };
  assert.deepEqual(axiRuntimeEnvironment(env), env);
  const selected = { ...env, PA_AXI_PATH: "/selected/quota/bin:/pinned/node/bin" };
  const result = axiRuntimeEnvironment(selected);
  assert.equal(result.PATH, `${selected.PA_AXI_PATH}:${env.PATH}`);
  assert.deepEqual(axiRuntimeEnvironment(result), result);
  assert.equal(selected.PATH, env.PATH);
  assert.equal(result.HOME, env.HOME);
});

test("PATH policy rejects malformed additions without echoing input or dropping inherited empty PATH entries", () => {
  for (const path of ["relative-sentinel", "/absolute:", "/absolute\nsecret-sentinel", "/absolute\0secret-sentinel"]) {
    assert.throws(() => axiRuntimeEnvironment({ PATH: "/host", PA_AXI_PATH: path }), (error: unknown) => error instanceof Error && /^AXI_POLICY_REJECTED:/.test(error.message) && !/sentinel/.test(error.message));
  }
  assert.equal(axiRuntimeEnvironment({ PA_AXI_PATH: "/selected/bin" }).PATH, "/selected/bin");
  assert.equal(axiRuntimeEnvironment({ PATH: "", PA_AXI_PATH: "/selected/bin" }).PATH, "/selected/bin:");
});

test("Nix selected-output wiring uses managed bins and only selected declared dependencies; other adapter prefixes unchanged", () => {
  const flake = readFileSync(new URL("../../../../flake.nix", import.meta.url), "utf8");
  assert.match(flake, /selectedAxiDependencies = pkgs\.lib\.unique/);
  assert.match(flake, /tool: \[ tool\.node \] \+\+ tool\.dependencies\) \(builtins\.attrValues selectedAxiTools\)/);
  assert.match(flake, /makeWrapper \$\{tool.node\}\/bin\/node \$share\/axi-bin\/\$\{name\}/);
  assert.match(flake, /dist\/axi-policy\.js/);
  for (const name of ["pa-core", "opa", "cpa", "dpa", "pa-platform-node"]) {
    const block = flake.split(` $out/bin/${name} \\\n`)[1]?.split("\n\n")[0];
    assert.ok(block, name);
    assert.match(block, /--prefix PATH : "\$\{runtimePath\}"/);
    assert.doesNotMatch(block, /axi/i);
  }
  const ppa = flake.split(" $out/bin/ppa \\\n")[1]?.split("\n\n")[0];
  assert.ok(ppa);
  assert.match(ppa, /--set PA_AXI_PATH/);
  assert.match(ppa, /optionalString \(selectedAxiTools != \{\}\)/);
  assert.match(ppa, /PA_PI_SQLITE_NATIVE_BINDING/);
  assert.match(ppa, /PA_REQUIRE_PI_SQLITE_NATIVE_BINDING/);
});

const consentValue = (id = "d-fixture") => ({ version: 1, deploymentId: id, providers: [{ id: "codex", profilePath: "/synthetic/codex" }, { id: "claude", profilePath: "/synthetic/claude" }] });
const quotaEnv = { PA_DEPLOYMENT_ID: "d-fixture", PA_DEPLOYMENT_DIR: "/synthetic/d-fixture", PA_AXI_QUOTA_CONSENT: "/synthetic/consent.json" };
function upstreamQuota(provider: QuotaProvider, state: Record<string, unknown> = { status: "fresh", stale: false }, extra: Record<string, unknown> = {}) {
  // quota-axi 0.1.56 types.d.ts / quotaJsonReport: schema 5 or 6, not
  // an invented flat usage schema. Identity/source/error fields are deliberate.
  return JSON.stringify({ schemaVersion: 6, generatedAt: "2026-10-10T04:00:00Z", help: ["secret-sentinel"], providers: [{ provider, accountKey: "identity-sentinel", accountKeys: ["identity-sentinel"], account: { email: "identity-sentinel" }, source: "/path-sentinel", token: "secret-sentinel", state: { ...state, error: "secret-sentinel /path-sentinel", remedyCommand: "secret-sentinel" }, windows: [{ id: "/path-sentinel", label: "identity-sentinel", kind: "session", percentUsed: 27, percentRemaining: 73, windowSeconds: 18000, resetsAt: "2026-10-10T09:00:00Z", spentUsd: 2, limitUsd: 10, resetText: "secret-sentinel", extra: "secret-sentinel" }], ...extra }] });
}
test("consent exact schema rejects unknown fields, providers, duplicate entries, relative paths and wrong deployment", () => {
  assert.deepEqual(parseQuotaConsent(consentValue(), "d-fixture"), consentValue());
  for (const value of [null, [], {}, { ...consentValue(), version: "1" }, { ...consentValue(), deploymentId: "d-other" }, { ...consentValue(), secret: true }, { ...consentValue(), providers: {} }, { ...consentValue(), providers: [{ id: "other", profilePath: "/x" }] }, { ...consentValue(), providers: [{ id: "codex", profilePath: "relative" }] }, { ...consentValue(), providers: [{ id: "codex", profilePath: "/x", token: "secret-sentinel" }] }, { ...consentValue(), providers: [{ id: "codex", profilePath: "/x" }, { id: "codex", profilePath: "/y" }] }, { ...consentValue(), providers: [{ id: "codex", profilePath: "/x\u0000" }] }]) {
    assert.throws(() => parseQuotaConsent(value, "d-fixture"), /^Error: AXI_POLICY_REJECTED$/);
  }
});
test("consent uses a bounded operator-owned 0600 regular file, rejects symlink/mode/owner before provider effects", () => {
  const dir = mkdtempSync(join(tmpdir(), "axi-consent-"));
  const path = join(dir, "consent.json"); const link = join(dir, "link.json");
  let requests = 0; let credentialReads = 0;
  const effects: QuotaEffects = { consent: readQuotaConsent, run: () => { requests++; credentialReads++; return { stdout: "", failed: false }; } };
  const input = { node: "/pinned/node", entrypoint: "/pinned/quota.js", args: [], env: { ...quotaEnv, PA_AXI_QUOTA_CONSENT: path } };
  try {
    writeFileSync(path, JSON.stringify(consentValue()), { mode: 0o600 });
    assert.deepEqual(readQuotaConsent(path, "d-fixture"), consentValue());
    symlinkSync(path, link);
    for (const mode of [0o644, 0o400, 0o666, 0o1600]) {
      chmodSync(path, mode);
      assert.throws(() => runManagedQuota(input, effects));
    }
    chmodSync(path, 0o600);
    assert.throws(() => runManagedQuota({ ...input, env: { ...input.env, PA_AXI_QUOTA_CONSENT: link } }, effects));
    for (const text of ["not JSON secret-sentinel", JSON.stringify(consentValue("d-other")), JSON.stringify(consentValue()).replace('"version":1', '"version":1,"version":1'), " ".repeat(65537)]) {
      writeFileSync(path, text);
      assert.throws(() => runManagedQuota(input, effects));
    }
    assert.equal(validConsentFile({ isFile: () => true, uid: 42, mode: 0o600, size: 12 }, 43), false);
    assert.equal(validConsentFile({ isFile: () => false, uid: 42, mode: 0o600, size: 12 }, 42), false);
    assert.equal(requests, 0); assert.equal(credentialReads, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("no/invalid consent and all public quota bypasses deny before credentials, discovery, refresh or provider requests", () => {
  let consentReads = 0; let credentialReads = 0; let requests = 0;
  const effects: QuotaEffects = { consent: () => { consentReads++; throw new Error("secret-sentinel /path-sentinel"); }, run: () => { credentialReads++; requests++; return { stdout: "", failed: false }; } };
  for (const args of [["--tui"], ["auth"], ["models"], ["discover"], ["refresh"], ["route"], ["--allow-keychain-prompt"], ["--allow-claude-inference"], ["quota", "--provider", "codex"], ["quota", "--profile-only"], ["quota", "--endpoint=http://fixture"], ["quota", "--max-age=1h"], ["--json", "--full"], ["quota", "--no-credential-refresh"], ["quota", "--json", "--json"]]) {
    const f = fixture("quota-axi", args, quotaEnv); f.effects.quota = effects;
    assert.equal(runManagedAxi(f.input, f.effects), 1);
    assert.match(f.stderr.join(""), /^AXI_POLICY_REJECTED:/);
  }
  for (const key of ["QUOTA_AXI_SNAPSHOT", "QUOTA_AXI_CODEX_BINARY", "QUOTA_AXI_MAX_AGE", "OPENAI_BASE_URL", "ANTHROPIC_API_URL"]) {
    const f = fixture("quota-axi", ["quota"], { ...quotaEnv, [key]: "secret-sentinel" }); f.effects.quota = effects;
    assert.equal(runManagedAxi(f.input, f.effects), 1);
  }
  assert.equal(consentReads, 0);
  for (const consent of [undefined, "/synthetic/consent.json"]) {
    const f = fixture("quota-axi", [], { ...quotaEnv, PA_AXI_QUOTA_CONSENT: consent }); f.effects.quota = effects;
    assert.equal(runManagedAxi(f.input, f.effects), 1);
    assert.doesNotMatch(f.stdout.join("") + f.stderr.join(""), /sentinel/);
  }
  assert.equal(consentReads, 1); assert.equal(credentialReads, 0); assert.equal(requests, 0);
  assert.throws(() => runManagedQuota({ node: "/pinned/node", entrypoint: "/pinned/quota.js", args: [], env: quotaEnv }, { ...effects, consent: () => ({ ...consentValue(), providers: [{ id: "codex", profilePath: "relative" }] } as never) }));
  assert.equal(requests, 0);
});
test("providers run separately only after full consent, with fixed args and positive environment allowlist", () => {
  const events: string[] = [];
  const effects: QuotaEffects = {
    consent: (path, id) => { events.push("consent"); assert.equal(path, quotaEnv.PA_AXI_QUOTA_CONSENT); assert.equal(id, "d-fixture"); return parseQuotaConsent(consentValue(), id); },
    run: (node, args, env) => {
      assert.equal(node, "/pinned/node");
      const provider = args[3] as QuotaProvider; events.push(provider);
      assert.deepEqual(args, ["/pinned/quota.js", "quota", "--provider", provider, "--profile-only", "--no-credential-refresh", "--json"]);
      assert.deepEqual(env, quotaProviderEnvironment({ id: provider, profilePath: `/synthetic/${provider}` }, quotaEnv.PA_DEPLOYMENT_DIR));
      assert.equal(env[provider === "codex" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"], undefined);
      assert.doesNotMatch(JSON.stringify(env), /secret-sentinel|identity-sentinel|path-sentinel/);
      return { stdout: upstreamQuota(provider), failed: false };
    },
  };
  const result = runManagedQuota({ node: "/pinned/node", entrypoint: "/pinned/quota.js", args: ["quota", "--json"], env: { ...quotaEnv, HOME: "/path-sentinel", PATH: "/path-sentinel", CODEX_HOME: "/path-sentinel", CLAUDE_CONFIG_DIR: "/path-sentinel", OPENAI_API_KEY: "secret-sentinel", ANTHROPIC_API_KEY: "secret-sentinel", NODE_OPTIONS: "secret-sentinel", HTTPS_PROXY: "secret-sentinel", AWS_SECRET_ACCESS_KEY: "secret-sentinel" } }, effects);
  assert.deepEqual(events, ["consent", "codex", "claude"]);
  assert.deepEqual(result.map((row) => row.status), ["fresh", "fresh"]);
  assert.doesNotMatch(JSON.stringify(result), /sentinel|account|source|token|error:/);
});
test("constructed schema/redaction fixtures preserve statuses (not actual pinned-provider acceptance)", () => {
  for (const version of [5, 6]) {
    const raw = upstreamQuota("codex").replace('"schemaVersion":6', `"schemaVersion":${version}`);
    const row = sanitizeQuotaResult(raw, "codex")[0]!;
    assert.equal(row.status, "fresh");
    assert.deepEqual(row.windows, [{ kind: "session", percentUsed: 27, percentRemaining: 73, spentUsd: 2, limitUsd: 10, windowSeconds: 18000, resetsAt: "2026-10-10T09:00:00.000Z" }]);
    assert.equal(row.generatedAt, "2026-10-10T04:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(row), /sentinel|account|token|source|remedy|help|label/);
  }
  for (const [state, extra, status] of [
    [{ status: "stale", stale: true, refreshedAt: "2026-10-09T04:00:00Z" }, {}, "stale"],
    [{ status: "auth_required", stale: false, reason: "credentials_expired" }, {}, "expired"],
    [{ status: "auth_required", stale: true, authStatus: "expired_refreshable" }, {}, "expired"],
    [{ status: "unavailable", stale: false }, { notSetUp: true }, "not-configured"],
    [{ status: "unavailable", stale: false }, {}, "unknown"],
    [{ status: "invented", stale: false }, {}, "unknown"],
    [{ status: "rate_limited", stale: false }, {}, "rate-limited"],
    [{ status: "error", stale: false }, {}, "error"],
    [{ status: "fresh", stale: true }, {}, "stale"],
    [{ status: "fresh", stale: false, reason: "credentials_expired", authStatus: "expired_refreshable" }, {}, "fresh"],
    [{ status: "fresh", stale: false }, { windows: [{ kind: "model", percentUsed: "0", percentRemaining: -1, limitUsd: "100", resetsAt: "/path-sentinel" }] }, "unknown"],
    [{ status: "fresh", stale: false }, { windows: [] }, "unknown"],
  ] as const) {
    const result = sanitizeQuotaResult(upstreamQuota("claude", state, extra), "claude");
    assert.equal(result[0]!.status, status);
    assert.doesNotMatch(JSON.stringify(result), /sentinel/);
    if (status === "stale" && "refreshedAt" in state) assert.equal(result[0]!.refreshedAt, "2026-10-09T04:00:00.000Z");
  }
  for (const raw of ["secret-sentinel", "{}", " ".repeat(1024 * 1024 + 1), upstreamQuota("codex").replace('"schemaVersion":6', '"schemaVersion":5,"schemaVersion":6'), upstreamQuota("claude"), upstreamQuota("codex").replace('"schemaVersion":6', '"schemaVersion":"6"'), upstreamQuota("codex").replace('"schemaVersion":6', '"schemaVersion":7')]) {
    assert.deepEqual(sanitizeQuotaResult(raw, "codex"), [{ provider: "codex", status: "unknown", reason: "invalid-response", windows: [] }]);
  }
});
test("quota subprocess failures and identity-bearing errors are sanitized without inventing zero/healthy", () => {
  for (const run of [() => { throw new Error("secret-sentinel identity-sentinel /path-sentinel"); }, () => ({ stdout: upstreamQuota("codex"), failed: true }), () => ({ stdout: "secret-sentinel", failed: false })]) {
    const f = fixture("quota-axi", ["quota"], quotaEnv);
    f.effects.quota = { consent: () => parseQuotaConsent({ ...consentValue(), providers: [consentValue().providers[0]] }, "d-fixture"), run };
    assert.equal(runManagedAxi(f.input, f.effects), 0);
    const out = f.stdout.join("") + f.stderr.join("");
    assert.doesNotMatch(out, /sentinel|percentUsed|fresh/);
    assert.equal(JSON.parse(f.stdout[0]!).providers[0].status, "unknown");
  }
});
const syntheticJwt = (payload: Record<string, unknown>) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${Buffer.from("synthetic-only-signature").toString("base64url")}`;
function syntheticProfile(provider: QuotaProvider, expiry: "expired" | "unexpired" | "absent") {
  const exp = expiry === "expired" ? 1 : 4102444800;
  return provider === "codex" ? { tokens: { access_token: syntheticJwt(expiry === "absent" ? {} : { exp }), id_token: syntheticJwt({ exp: 1 }), refresh_token: "secret-sentinel" } }
    : { claudeAiOauth: { accessToken: "synthetic-only-never-a-vendor-token", ...(expiry === "absent" ? {} : { expiresAt: exp * 1000 }), refreshToken: "secret-sentinel" } };
}

test("expiry evidence reads only safe bounded exact profiles; strict metadata parsing and internal clock bounds", () => {
  const root = mkdtempSync(join(tmpdir(), "axi-expiry-"));
  try {
    for (const id of ["codex", "claude"] as const) {
      const profilePath = join(root, id); mkdirSync(profilePath, { mode: 0o700 });
      const file = join(profilePath, id === "codex" ? "auth.json" : ".credentials.json");
      const provider = { id, profilePath };
      for (const expiry of ["expired", "unexpired", "absent"] as const) {
        writeFileSync(file, JSON.stringify(syntheticProfile(id, expiry)), { mode: 0o600 });
        assert.equal(readQuotaProfileExpired(provider, 2000), expiry === "expired");
        assert.equal(readQuotaProfileExpired(provider, NaN), false);
      }
      // Accepted pinned aliases/formats; access-token expiry only, not ID-token.
      const good = id === "codex" ? { tokens: { accessToken: syntheticJwt({ exp: "1" }) } } : { access_token: "synthetic", expiresAt: "1970-01-01T00:00:01Z" };
      writeFileSync(file, JSON.stringify(good)); assert.equal(readQuotaProfileExpired(provider, 1000), true);
      assert.equal(readQuotaProfileExpired(provider, 999), false);
      const invalid = id === "codex" ? [
        { tokens: { access_token: "bad.jwt.shape" } }, { tokens: { access_token: `${syntheticJwt({ exp: 1 }).split('.').slice(0, 2).join('.')}.a` } }, { tokens: { access_token: syntheticJwt({ exp: "bad" }) } },
        { tokens: { access_token: syntheticJwt({ exp: -1 }) } }, { tokens: { access_token: syntheticJwt({ exp: 1 }), accessToken: syntheticJwt({ exp: 1 }) } },
        { tokens: { id_token: syntheticJwt({ exp: 1 }) } },
      ] : [
        { claudeAiOauth: { expiresAt: 1 } }, { claudeAiOauth: { accessToken: "synthetic", expiresAt: "bad" } }, { claudeAiOauth: { accessToken: "synthetic", expiresAt: "1970-02-30T00:00:00Z" } },
        { claudeAiOauth: { accessToken: "synthetic", expiresAt: -1 } }, { claudeAiOauth: { accessToken: "a", access_token: "b", expiresAt: 1 } },
        { claudeAiOauth: [], accessToken: "synthetic", expiresAt: 1 },
      ];
      for (const value of invalid) { writeFileSync(file, JSON.stringify(value)); assert.equal(readQuotaProfileExpired(provider, 2000), false); }
      for (const text of ['{"tokens":{},"tokens":{}}', '{"claudeAiOauth":{},"claudeAiOauth":{}}', "bad", " ".repeat(65537), '[ '.repeat(33) + '0' + ' ]'.repeat(33)]) {
        writeFileSync(file, text); assert.equal(readQuotaProfileExpired(provider, 2000), false);
      }
      writeFileSync(file, Buffer.from([0xff])); assert.equal(readQuotaProfileExpired(provider, 2000), false);
      writeFileSync(file, JSON.stringify(good));
      const hard = join(root, `${id}-hard`); linkSync(file, hard);
      assert.equal(readQuotaProfileExpired(provider, 2000), false); rmSync(hard);
      assert.equal(readQuotaProfileExpired(provider, 2000, "different-inode-or-time"), false);
      chmodSync(file, 0o644); assert.equal(readQuotaProfileExpired(provider, 2000), false); chmodSync(file, 0o600);
      rmSync(file); symlinkSync(join(root, "foreign-sentinel"), file);
      assert.equal(readQuotaProfileExpired(provider, 2000), false);
      rmSync(file); writeFileSync(file, JSON.stringify(good), { mode: 0o600 });
      const link = join(root, `${id}-link`); symlinkSync(profilePath, link);
      assert.equal(readQuotaProfileExpired({ id, profilePath: link }, 2000), false);
      chmodSync(profilePath, 0o777); assert.equal(readQuotaProfileExpired(provider, 2000), false); chmodSync(profilePath, 0o700);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("expiry enrichment requires a single empty non-stale auth denial, never successful/advisory, generic or ambiguous evidence", () => {
  let reads = 0;
  const evidence = () => { reads++; return true; };
  const denied = upstreamQuota("codex", { status: "auth_required", stale: false }, { windows: [] });
  assert.equal(sanitizeQuotaResult(denied, "codex", evidence)[0]!.status, "expired");
  assert.equal(reads, 1);
  assert.equal(sanitizeQuotaResult(denied, "codex", () => false)[0]!.status, "unknown");
  for (const [state, extra] of [
    [{ status: "fresh", stale: false }, {}], [{ status: "auth_required", stale: true }, { windows: [] }],
    [{ status: "auth_required" }, { windows: [] }], [{ status: "unavailable", stale: false }, { windows: [] }],
    [{ status: "error", stale: false }, { windows: [] }], [{ status: "auth_required", stale: false }, {}],
    [{ status: "auth_required", stale: false }, { windows: [], notSetUp: true }],
  ] as const) sanitizeQuotaResult(upstreamQuota("codex", state, extra), "codex", evidence);
  const multiple = JSON.parse(denied) as { providers: unknown[] }; multiple.providers.push(multiple.providers[0]);
  assert.equal(sanitizeQuotaResult(JSON.stringify(multiple), "codex", evidence)[0]!.status, "unknown");
  assert.equal(reads, 1);
  const effects: QuotaEffects = { consent: () => ({ ...consentValue(), providers: [consentValue().providers[0], { id: "other", profilePath: "/foreign" }] } as never), run: () => { throw new Error("must not run"); }, expiredProfile: () => { reads++; return true; } };
  assert.throws(() => runManagedQuota({ node: "/node", entrypoint: "/quota", args: [], env: quotaEnv }, effects));
  assert.equal(reads, 1);
});

test("actual pinned 0.1.56 CLI/providers/serialization with synthetic profiles and transport-only responses", {
  skip: process.env.PAP240_PINNED_QUOTA_ENTRY ? false : "materialize pinned quota and set PAP240_PINNED_QUOTA_ENTRY; installed smoke requires this case without skips",
}, () => {
  const entrypoint = process.env.PAP240_PINNED_QUOTA_ENTRY!;
  assert.match(entrypoint, /^\/nix\/store\/[^/]+-quota-axi-0\.1\.56\/lib\/quota-axi\/node_modules\/quota-axi\/dist\/bin\/quota-axi\.js$/);
  const root = mkdtempSync(join(tmpdir(), "axi-pinned-quota-"));
  const dir = join(root, "d-pinned"); mkdirSync(dir, { mode: 0o700 });
  const ledger = join(root, "effects.jsonl"); const consent = join(root, "consent.json");
  const observer = fileURLToPath(new URL("../../../../scripts/axi-smoke/observe.cjs", import.meta.url));
  const preload = fileURLToPath(new URL("../../../../scripts/axi-smoke/pinned-quota.cjs", import.meta.url));
  const policy = fileURLToPath(new URL("../axi-policy.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../../../../node_modules/tsx/dist/esm/index.mjs", import.meta.url));
  const env: NodeJS.ProcessEnv = { PATH: "", HOME: join(root, "empty-home"), PA_DEPLOYMENT_ID: "d-pinned", PA_DEPLOYMENT_DIR: dir, PA_AXI_QUOTA_CONSENT: consent,
    AXI_SMOKE_ROOT: root, AXI_SMOKE_LEDGER: ledger, AXI_SMOKE_QUOTA_ENTRY: entrypoint, AXI_SMOKE_PINNED: "1", AXI_SMOKE_PINNED_PRELOAD: preload,
    CODEX_HOME: "/path-sentinel", CLAUDE_CONFIG_DIR: "/identity-sentinel", OPENAI_API_KEY: "secret-sentinel" };
  const invoke = (changes: NodeJS.ProcessEnv = {}, expected = 0) => {
    writeFileSync(ledger, "", { mode: 0o600 });
    const result = spawnSync(process.execPath, ["--import", tsx, "--input-type=module", "--eval", `
      import { createRequire } from 'node:module';
      const { runManagedAxi } = await import(${JSON.stringify(policy)});
      createRequire(import.meta.url)(${JSON.stringify(observer)});
      process.exitCode = runManagedAxi({ tool: 'quota-axi', node: process.execPath,
        entrypoint: process.env.AXI_SMOKE_QUOTA_ENTRY, gh: '-', args: ['quota', '--json'], env: process.env });
    `], {
      env: { ...env, ...changes }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined); assert.equal(result.status, expected);
    assert.doesNotMatch(result.stdout + result.stderr, /sentinel|synthetic-only|account|source|token|auth\.json|credentials\.json/);
    const events = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string; endpoint?: string; status?: string; stale?: boolean; windows?: number });
    assert.equal(events.filter(row => row.kind === "observerLoaded").length, 1);
    assert.equal(events.some(row => /unexpected|forbidden|badProvider/.test(row.kind)), false);
    return { result, events };
  };
  try {
    for (const id of ["codex", "claude"] as const) {
      const profilePath = join(root, "profiles", id); mkdirSync(profilePath, { recursive: true, mode: 0o700 });
      const file = join(profilePath, id === "codex" ? "auth.json" : ".credentials.json");
      const value = { version: 1, deploymentId: "d-pinned", providers: [{ id, profilePath }] };
      writeFileSync(consent, JSON.stringify(value), { mode: 0o600 });
      for (const expiry of ["expired", "unexpired", "absent"] as const) for (const response of ["denied", "fresh"]) {
        writeFileSync(file, JSON.stringify(syntheticProfile(id, expiry)), { mode: 0o600 });
        const { result, events } = invoke({ AXI_SMOKE_RESPONSE: response });
        const rows = (JSON.parse(result.stdout) as { providers: { status: string; windows: unknown[] }[] }).providers;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.status, response === "fresh" ? "fresh" : expiry === "expired" ? "expired" : "unknown", JSON.stringify({ id, expiry, response, output: rows, effects: events.map(row => row.kind === "pinnedChildExit" ? row : { kind: row.kind }) }));
        const upstream = events.filter(row => row.kind === "pinnedUpstreamState");
        assert.equal(upstream.length, 1);
        assert.equal(upstream[0]!.status, response === "fresh" ? "fresh" : "auth_required");
        assert.equal(upstream[0]!.stale, false);
        assert.equal(upstream[0]!.windows, response === "fresh" ? 1 : 0);
        assert.equal(events.filter(row => row.kind === "pinnedTransportLoaded").length, 1);
        assert.equal(events.filter(row => row.kind === "providerInvocation").length, 1);
        assert.equal(events.filter(row => row.kind === "providerRequest").length, id === "codex" && response === "fresh" ? 1 : id === "claude" && response === "denied" ? 1 : 2);
        assert.ok(events.some(row => row.kind === "credentialRead"));
        if (response === "fresh") assert.equal(events.filter(row => row.kind === "profileEvidenceRead").length, 0);
      }
      const malformedEvidence = id === "codex"
        ? JSON.stringify({ tokens: { access_token: syntheticJwt({ exp: "malformed" }) } })
        : JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", expiresAt: "malformed" } });
      const duplicateEvidence = id === "codex"
        ? `{"tokens":{},"tokens":${JSON.stringify({ access_token: syntheticJwt({ exp: 1 }) })}}`
        : '{"claudeAiOauth":{},"claudeAiOauth":{"accessToken":"synthetic","expiresAt":1000}}';
      for (const text of [malformedEvidence, duplicateEvidence]) {
        writeFileSync(file, text);
        const { result, events } = invoke({ AXI_SMOKE_RESPONSE: "denied" });
        assert.equal(JSON.parse(result.stdout).providers[0].status, "unknown");
        assert.equal(events.find(row => row.kind === "pinnedUpstreamState")!.status, "auth_required");
        assert.ok(events.some(row => row.kind === "providerRequest"));
      }
      // Malformed profile JSON is an upstream error, NOT fabricated expiry.
      writeFileSync(file, '{');
      const malformed = invoke({ AXI_SMOKE_RESPONSE: "denied" });
      assert.equal(JSON.parse(malformed.result.stdout).providers[0].status, "error");
      assert.equal(malformed.events.filter(row => row.kind === "providerRequest").length, 0);
      rmSync(file);
      const absent = invoke();
      assert.equal(JSON.parse(absent.result.stdout).providers[0].status, "not-configured");
      assert.equal(absent.events.filter(row => row.kind === "providerRequest").length, 0);
      for (const changes of [{ PA_AXI_QUOTA_CONSENT: undefined }, {}]) {
        writeFileSync(consent, JSON.stringify({ ...value, providers: [...value.providers, { id: "other", profilePath }] }));
        const { events } = invoke(changes, 1);
        assert.equal(events.filter(row => ["credentialRead", "profileMetadata", "profileEvidenceRead", "providerRequest", "providerInvocation"].includes(row.kind)).length, 0);
      }
      writeFileSync(consent, JSON.stringify(value));
      writeFileSync(file, JSON.stringify(syntheticProfile(id, "expired")));
      for (const unsafe of ["mode", "foreign", "oversize", "symlink"] as const) {
        if (unsafe === "mode") chmodSync(file, 0o644);
        if (unsafe === "oversize") writeFileSync(file, " ".repeat(65537));
        if (unsafe === "symlink") { rmSync(file); symlinkSync(join(root, "foreign-sentinel"), file); }
        const { result, events } = invoke(unsafe === "foreign" ? { AXI_SMOKE_FOREIGN_PROFILE: "1" } : {});
        assert.equal(JSON.parse(result.stdout).providers[0].status, "unknown");
        assert.equal(events.filter(row => ["providerInvocation", "providerRequest", "profileEvidenceRead"].includes(row.kind)).length, 0);
        if (unsafe === "symlink") rmSync(file);
        writeFileSync(file, JSON.stringify(syntheticProfile(id, "expired")), { mode: 0o600 }); chmodSync(file, 0o600);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("browser safe public arguments and pinned MCP arguments reject all attach/profile/shared/extra bypasses", () => {
  for (const args of [["start", "--headless=false"], ["attach"], ["start", "--browser-url=http://foreign"], ["start", "--wsEndpoint=ws://foreign"], ["start", "--userDataDir=/foreign"], ["start", "--executablePath=/foreign"], ["start", "--chrome-arg=--remote-debugging-address=0.0.0.0"], ["start", "--channel=stable"], ["start", "--isolated=false"], ["start", "extra"], ["open", "\u0000"]]) assert.equal(browserArgumentsAllowed(args, {}), false);
  for (const key of ["CHROME_DEVTOOLS_AXI_AUTO_CONNECT", "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL", "CHROME_DEVTOOLS_AXI_USER_DATA_DIR", "CHROME_DEVTOOLS_AXI_MCP_PATH", "CHROME_DEVTOOLS_AXI_CHROME_ARGS", "CHROME_DEVTOOLS_MCP_ARGS"]) assert.equal(browserArgumentsAllowed(["start"], { [key]: "secret-sentinel" }), false);
  assert.equal(browserArgumentsAllowed(["open", "http://127.0.0.1/fixture"], {}), true);
  const args = pinnedMcpArguments("/pinned/mcp.js", "/operator/chrome", "/deployment/profile");
  assert.equal(args[0], "/pinned/mcp.js"); assert.ok(args.includes("--executablePath=/operator/chrome")); assert.ok(args.includes("--userDataDir=/deployment/profile"));
  assert.ok(args.includes("--headless")); assert.ok(args.includes("--no-usage-statistics"));
  assert.ok(args.includes("--chrome-arg=--remote-debugging-pipe")); assert.ok(!args.includes("--isolated"));
  assert.doesNotMatch(args.join(" "), /remote-debugging-address|remote-debugging-port|no-page-id-routing/);
  assert.doesNotMatch(args.join(" "), /latest|npx|autoConnect|browserUrl|wsEndpoint|0\.0\.0\.0/);
  assert.throws(() => pinnedMcpArguments("relative", "/chrome", "/profile"));
  assert.equal(BROWSER_READINESS_MS, 30000); assert.equal(BROWSER_IDLE_MS, 300000); assert.equal(BROWSER_CLEANUP_MS, 10000);
});
function processFixture() {
  let now = 0;
  const uid = process.getuid!();
  const rows = new Map<number, ProcessIdentity>([[10, { pid: 10, start: "100", session: 10, uid, zombie: false }], [11, { pid: 11, start: "101", session: 10, uid, zombie: false }], [12, { pid: 12, start: "102", session: 10, uid, zombie: false }], [99, { pid: 99, start: "1", session: 99, uid, zombie: false }]]);
  const signals: [number, NodeJS.Signals][] = [];
  const effects: BrowserProcessEffects = { list: () => [...rows.values()], inspect: (pid) => rows.get(pid), now: () => now, sleep: async (ms) => { now += ms; }, signal: (pid, signal) => { assert.ok(pid > 0); signals.push([pid, signal]); if (signal === "SIGKILL") rows.delete(pid); } };
  return { rows, effects, signals, now: () => now };
}
test("bridge leader exit still cleans verified descendants, escalates within bound and never signals foreign group/PID", async () => {
  const f = processFixture(); const witness = f.rows.get(12)!;
  f.rows.delete(11); // bridge leader already gone, daemon session remains
  await cleanupBrowserSession({ pid: 10, start: "100" }, [witness], f.effects);
  assert.ok(f.signals.some(([pid, signal]) => pid === 12 && signal === "SIGKILL"));
  assert.ok(f.signals.every(([pid]) => pid === 12)); assert.ok(f.now() < BROWSER_CLEANUP_MS);
  assert.ok(f.rows.has(99)); assert.ok(f.rows.has(10));
  const orphan = processFixture(); const witnesses = [orphan.rows.get(11)!]; orphan.rows.delete(10);
  await cleanupBrowserSession({ pid: 10, start: "100" }, witnesses, orphan.effects);
  assert.ok(!orphan.rows.has(11) && !orphan.rows.has(12) && orphan.rows.has(99));
});
test("reused leader/witness, foreign uid, indeterminate orphan session and per-signal PID reuse reject untouched", async () => {
  for (const kind of ["leader", "witness", "uid", "unanchored"] as const) {
    const f = processFixture(); const witness = f.rows.get(11)!;
    if (kind === "leader") f.rows.set(10, { ...f.rows.get(10)!, start: "900" });
    if (kind === "witness") { f.rows.delete(10); f.rows.set(11, { ...witness, start: "900", session: 99 }); }
    if (kind === "uid") f.rows.set(12, { ...f.rows.get(12)!, uid: f.rows.get(12)!.uid + 1 });
    if (kind === "unanchored") f.rows.delete(10);
    await assert.rejects(cleanupBrowserSession({ pid: 10, start: "100" }, kind === "unanchored" ? [] : [witness], f.effects), /AXI_POLICY_REJECTED/);
    assert.deepEqual(f.signals, []);
  }
  const f = processFixture();
  const list = f.effects.list;
  f.effects.list = () => { const values = list(); for (const pid of [11, 12]) f.rows.set(pid, { ...f.rows.get(pid)!, start: "999", session: 99 }); return values; };
  await cleanupBrowserSession({ pid: 10, start: "100" }, [], f.effects);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(ownedSessionProcesses({ pid: 10, start: "100" }, [], f.effects), []);
});
test("exit, cancellation, failure, and daemon lifecycle polling always await cleanup (idle is not a substitute)", async () => {
  for (const reason of ["exit", "cancel", "failure"]) {
    let alive = true; let cleaned = 0; let elapsed = 0;
    await superviseBrowserLifetime({ now: () => elapsed, sleep: async (ms) => { elapsed += ms; alive = false; }, lifecycleAlive: () => reason !== "exit" && alive, bridgeAlive: () => reason !== "failure" && alive, cleanup: async () => { cleaned++; } });
    assert.equal(cleaned, 1); assert.ok(elapsed <= 100);
  }
  let cleaned = false;
  await assert.rejects(superviseBrowserLifetime({ now: () => 0, sleep: async () => { throw new Error("failure"); }, lifecycleAlive: () => true, bridgeAlive: () => true, cleanup: async () => { cleaned = true; } }), /failure/);
  assert.equal(cleaned, true);
  for (const result of [Promise.resolve({ status: 0, stdout: "", stderr: "" }), Promise.resolve({ status: 143, stdout: "", stderr: "" }), Promise.reject(new Error("failed"))]) {
    let count = 0;
    try { await finishBrowserLifecycle(result, {}, async () => { count++; }); } catch { /* failure preserved */ }
    assert.equal(count, 1);
  }
});

test("default-disabled adapter cleanup needs no browser context when state is absent, but existing state stays fail-closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-disabled-cleanup-"));
  // Ordinary adapter fixtures/deployments do not promise a browser-bound
  // directory basename or lifecycle identity until a browser is started.
  const env = { PA_DEPLOYMENT_ID: "ordinary-deployment", PA_DEPLOYMENT_DIR: root, PA_AXI_PATH: "" };
  try {
    await cleanupManagedBrowser(env);
    const success = { status: 0, stdout: "unchanged", stderr: "" };
    assert.equal(await finishBrowserLifecycle(Promise.resolve(success), env), success);
    const failure = new Error("original adapter failure");
    await assert.rejects(finishBrowserLifecycle(Promise.reject(failure), env), (error: unknown) => error === failure);
    const state = join(root, "axi-browser");
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, "owner.json"), "foreign-owner-sentinel", { mode: 0o600 });
    // Neither an empty selection nor missing browser lifecycle can waive
    // ownership validation if any browser state actually exists.
    await assert.rejects(cleanupManagedBrowser(env), /AXI_POLICY_REJECTED/);
    assert.equal(readFileSync(join(state, "owner.json"), "utf8"), "foreign-owner-sentinel");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function waitUntil(check: () => boolean, bound = 6000) {
  const deadline = performance.now() + bound;
  while (!check() && performance.now() < deadline) await new Promise((done) => setTimeout(done, 25));
  assert.equal(check(), true);
}
function fakeBrowser(root: string, id: string, mode = "normal") {
  const dir = join(root, id); mkdirSync(dir, { mode: 0o700 });
  const bin = join(root, `bin-${id}`); mkdirSync(bin);
  const entrypoint = join(bin, "chrome-devtools-axi.js"); writeFileSync(entrypoint, "");
  writeFileSync(join(bin, "chrome-devtools-axi-bridge.js"), `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const http=require('node:http');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.writeFileSync('fixture-descendant.json',JSON.stringify({pid:child.pid}));
${mode === "leader-exit" ? "setTimeout(()=>process.exit(7),750);" : ""}
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(req.url.startsWith('/health')?{status:'ok',session:process.env.CHROME_DEVTOOLS_AXI_SESSION}:{error:'fixture-failure'}));}); server.listen(Number(process.env.CHROME_DEVTOOLS_AXI_PORT),'127.0.0.1');`);
  const env = browserLifecycleEnvironment({ PA_DEPLOYMENT_ID: id, PA_DEPLOYMENT_DIR: dir });
  return { dir, env, input: { node: process.execPath, entrypoint, mcp: "/pinned/synthetic-mcp.js", chrome: "/synthetic/chrome", args: ["start"], env } };
}
test("real synthetic daemon startup races, concurrent deployment isolation, bridge leader exit and call failure leave no descendants/state", { timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-browser-"));
  const a = fakeBrowser(root, "d-fixturea"); const b = fakeBrowser(root, "d-fixtureb", "leader-exit");
  const state = (f: typeof a) => join(f.dir, "axi-browser");
  try {
    // Simultaneous starts exercise atomic owner publication; separate deployments
    // are separate detached sessions, profiles and private listeners.
    assert.deepEqual(await Promise.all([runBrowserCommand(a.input), runBrowserCommand(b.input)]), ["browser ready\n", "browser ready\n"]);
    const ownerA = JSON.parse(readFileSync(join(state(a), "owner.json"), "utf8"));
    const ownerB = JSON.parse(readFileSync(join(state(b), "owner.json"), "utf8"));
    assert.notEqual(ownerA.pid, ownerB.pid); assert.notEqual(ownerA.port, ownerB.port);
    const pidA = JSON.parse(readFileSync(join(state(a), "fixture-descendant.json"), "utf8")).pid as number;
    const pidB = JSON.parse(readFileSync(join(state(b), "fixture-descendant.json"), "utf8")).pid as number;
    await waitUntil(() => !existsSync(state(b)));
    await waitUntil(() => processIdentity(pidB) === undefined || readFileSync(`/proc/${pidB}/stat`, "utf8").includes(") Z "));
    await assert.rejects(runBrowserCommand({ ...a.input, args: ["pages"] }), /AXI_POLICY_REJECTED/);
    assert.equal(existsSync(state(a)), false);
    await waitUntil(() => processIdentity(pidA) === undefined || readFileSync(`/proc/${pidA}/stat`, "utf8").includes(") Z "));
  } finally {
    for (const f of [a, b]) { try { await cleanupManagedBrowser(f.env); } catch { /* reported by assertions */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
test("managed MCP shim runs only the fixed Node/MCP/Chrome argv, rejects upstream overrides without a child", () => {
  const root = mkdtempSync(join(tmpdir(), "axi-mcp-shim-"));
  try {
    const shim = join(root, "mcp.cjs"); const mcp = join(root, "synthetic-mcp.cjs"); const marker = join(root, "executed"); const profile = join(root, "profile");
    writeFileSync(mcp, `const fs=require('node:fs'); const {spawn}=require('node:child_process'); fs.writeFileSync(${JSON.stringify(marker)},'yes');
const session=pid=>{const s=fs.readFileSync('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[3]};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
let groupRejected=false,foreignRejected=false; try{process.kill(-child.pid,'SIGTERM')}catch(e){groupRejected=e.code==='ESRCH'} try{process.kill(process.ppid,0)}catch(e){foreignRejected=e.code==='ESRCH'};
const report={args:process.argv.slice(2),environment:{...process.env},sameSession:session(child.pid)===session(process.pid),groupRejected,foreignRejected};
child.on('exit',()=>process.stdout.write(JSON.stringify(report))); process.kill(child.pid,'SIGTERM');`);
    writeFileSync(shim, managedMcpShim(process.execPath, mcp, "/synthetic/chrome", profile));
    const expected = [`--userDataDir=${profile}`, "--headless", "--chrome-arg=--use-mock-keychain", "--chrome-arg=--password-store=basic"];
    const pinnedBridge = process.env.PAP240_PINNED_BROWSER_BRIDGE;
    if (pinnedBridge) {
      const actual = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        const bridge = await import(${JSON.stringify(pinnedBridge)});
        process.stdout.write(JSON.stringify(bridge.buildTransportArgs().slice(2)));
      `], { env: { PATH: "", HOME: root, CHROME_DEVTOOLS_AXI_USER_DATA_DIR: profile }, encoding: "utf8", timeout: 5000 });
      assert.equal(actual.status, 0, actual.stderr);
      assert.deepEqual(JSON.parse(actual.stdout), expected);
    }
    const accepted = spawnSync(process.execPath, [shim, ...expected], { env: { PATH: "", GH_TOKEN: "synthetic-do-not-inherit", HTTPS_PROXY: "http://synthetic.invalid", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "0", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "0" }, encoding: "utf8", timeout: 5000 });
    assert.equal(accepted.status, 0); assert.deepEqual(JSON.parse(accepted.stdout), {
      args: pinnedMcpArguments(mcp, "/synthetic/chrome", profile).slice(1),
      environment: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home", "config"), XDG_CACHE_HOME: join(root, "home", "cache"), TMPDIR: join(root, "tmp"), PATH: dirname(process.execPath), LANG: "C.UTF-8", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
      sameSession: true, groupRejected: true, foreignRejected: true,
    });
    rmSync(marker);
    for (const args of [[], [expected[0], expected[1], expected[3], expected[2]], [...expected, "--browserUrl=http://foreign"], [...expected, "--no-usage-statistics=false"], ["--isolated"], ["--help"], ["--executablePath=/foreign"]]) {
      const denied = spawnSync(process.execPath, [shim, ...args], { env: { PATH: "" }, encoding: "utf8", timeout: 5000 });
      assert.equal(denied.status, 1); assert.equal(denied.stdout + denied.stderr, ""); assert.equal(existsSync(marker), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("actual pinned MCP/Puppeteer fixed arguments choose five-slot CDP pipe without spawning Chrome", { skip: !process.env.PAP240_PINNED_MCP_ENTRYPOINT }, () => {
  const root = mkdtempSync(join(tmpdir(), "axi-pinned-transport-"));
  try {
    const mcp = process.env.PAP240_PINNED_MCP_ENTRYPOINT!;
    const module = join(dirname(mcp), "../BrowserManager.js");
    const chromeArg = pinnedMcpArguments(mcp, process.execPath, join(root, "profile")).filter(arg => arg.startsWith("--chrome-arg=")).map(arg => arg.slice("--chrome-arg=".length));
    const actual = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
      let capture; cp.spawn=(command,args,options)=>{capture={args,slots:options.stdio.length};throw new Error('bounded-spawn-interception')}; syncBuiltinESMExports();
      const {BrowserManager}=await import(${JSON.stringify(module)});
      const manager=new BrowserManager({executablePath:process.execPath,userDataDir:${JSON.stringify(join(root, "profile"))},headless:true,chromeArg:${JSON.stringify(chromeArg)}});
      try{await manager.ensureBrowser()}catch{}
      if(!capture)process.exit(1);process.stdout.write(JSON.stringify(capture));
    `], { env: { PATH: "", HOME: root }, encoding: "utf8", timeout: 5000 });
    assert.equal(actual.status, 0);
    const capture = JSON.parse(actual.stdout) as { args: string[]; slots: number };
    assert.equal(capture.slots, 5); assert.ok(capture.args.includes("--remote-debugging-pipe"));
    assert.ok(!capture.args.some(arg => /^--remote-debugging-(port|address)/.test(arg)));
    assert.ok(!capture.args.includes("--no-sandbox"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("foreign loopback listener cannot be mistaken for the owned bridge, even with plausible health", async () => {
  const server = createServer();
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    assert.equal(ownsListener({ pid: process.pid, port: address.port }), true);
    assert.equal(ownsListener({ pid: 2147483647, port: address.port }), false);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
});
test("normal stop/cancellation clean actual synthetic daemon descendants within bound; missing runtime rolls back private startup state", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-browser-stop-")); const f = fakeBrowser(root, "d-stop");
  const state = join(f.dir, "axi-browser");
  try {
    assert.equal(await runBrowserCommand(f.input), "browser ready\n");
    const owner = JSON.parse(readFileSync(join(state, "owner.json"), "utf8"));
    const started = performance.now();
    await cleanupManagedBrowser(f.env); // cancellation path used by both PPA runners
    assert.ok(performance.now() - started < BROWSER_CLEANUP_MS);
    assert.equal(existsSync(state), false);
    await waitUntil(() => processIdentity(owner.pid) === undefined);
    assert.equal(await runBrowserCommand({ ...f.input, args: ["stop"] }), "browser stopped\n");
    await assert.rejects(runBrowserCommand({ ...f.input, node: "/nonexistent/synthetic-node" }), /AXI_POLICY_REJECTED/);
    assert.equal(existsSync(state), false);
  } finally { try { await cleanupManagedBrowser(f.env); } catch { /* assertion captures failure */ } rmSync(root, { recursive: true, force: true }); }
});
test("foreign state and deployment binding reject without changing profile/process sentinel",  async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-browser-foreign-")); const f = fakeBrowser(root, "d-foreign");
  const state = join(f.dir, "axi-browser"); mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, "sentinel"), "foreign-profile-sentinel");
  writeFileSync(join(state, "owner.json"), JSON.stringify({ id: "d-other", pid: process.pid, start: processIdentity(process.pid) }), { mode: 0o600 });
  try {
    await assert.rejects(runBrowserCommand(f.input));
    await assert.rejects(cleanupManagedBrowser(f.env));
    assert.equal(readFileSync(join(state, "sentinel"), "utf8"), "foreign-profile-sentinel");
    assert.equal(processIdentity(process.pid), f.env.PA_AXI_LIFECYCLE_START);
    assert.throws(() => browserContext({ ...f.env, PA_DEPLOYMENT_ID: "d-other" }));
    assert.throws(() => browserContext({ ...f.env, PA_AXI_LIFECYCLE_START: "0" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("same-deployment startup collision rejects the loser before reuse or termination and preserves winner", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-browser-race-")); const f = fakeBrowser(root, "d-race");
  try {
    const results = await Promise.allSettled([runBrowserCommand(f.input), runBrowserCommand(f.input)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const state = join(f.dir, "axi-browser"); assert.equal(existsSync(state), true);
    const owner = JSON.parse(readFileSync(join(state, "owner.json"), "utf8"));
    assert.equal(processIdentity(owner.pid), owner.start);
    assert.equal(await runBrowserCommand(f.input), "browser ready\n");
    // A different configured Chrome must reject without replacing this owner.
    await assert.rejects(runBrowserCommand({ ...f.input, chrome: "/foreign/chrome" }), /AXI_POLICY_REJECTED/);
    assert.equal(processIdentity(owner.pid), owner.start);
    assert.equal(JSON.parse(readFileSync(join(state, "owner.json"), "utf8")).token, owner.token);
    await cleanupManagedBrowser(f.env); assert.equal(existsSync(state), false);
  } finally { try { await cleanupManagedBrowser(f.env); } catch { /* assertion captures failure */ } rmSync(root, { recursive: true, force: true }); }
});
test("Phase-4 installed smoke is separate, exact-CLI, complete-or-fail and has no source/fixture-success fallback", () => {
  const root = new URL("../../../../", import.meta.url);
  const shell = readFileSync(new URL("scripts/axi-nix-output-smoke.sh", root), "utf8");
  const matrix = readFileSync(new URL("scripts/axi-smoke/matrix.py", root), "utf8");
  const runtime = readFileSync(new URL("scripts/axi-smoke/runtime.mjs", root), "utf8");
  assert.match(shell, /--system x86_64-linux --eval-system aarch64-linux --all-selections --chrome PATH --log-file PATH/);
  assert.match(shell, /\$# -ne 9/);
  assert.match(matrix, /self\.required == set\(self\.data\["cases"\]\)/);
  assert.match(matrix, /len\(set\(self\.data\["nativeOutputs"\]\.values\(\)\)\) == 8/);
  assert.match(matrix, /--option", "sandbox", "true"/);
  assert.match(matrix, /--unshare-net/);
  assert.match(matrix, /--unshare-pid/);
  assert.match(matrix, /"--perms", "0700", "--tmpfs", "\/tmp", "--bind"/);
  assert.match(matrix, /trace=process,network,openat/);
  assert.match(runtime, /share\/pa-platform\/packages\/pi-pa\/dist/);
  assert.match(runtime, /await import\(join\(modules, 'axi-browser\.js'\)\)/);
  assert.match(runtime, /asyncCommand\(shim\(all, 'chrome-devtools-axi'\)/);
  assert.doesNotMatch(shell + matrix + runtime, /PAP183_SMOKE_CAPTURE_FIXTURE|tsx|src\/axi-(?:policy|browser|quota)/);
  // Syntax coverage for the coordinator/helpers without executing their matrix,
  // importing production outputs, evaluating Nix, or launching Chrome.
  const parsed = spawnSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", fileURLToPath(new URL("scripts/axi-smoke/matrix.py", root))], { encoding: "utf8", timeout: 5000 });
  assert.equal(parsed.status, 0, parsed.stderr);
  for (const filename of ["runtime.mjs", "provider.mjs", "observe.cjs", "pinned-quota.cjs", "capture-wrapper.mjs", "consent-fixture.mjs"]) {
    const syntax = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(`scripts/axi-smoke/${filename}`, root))], { encoding: "utf8", timeout: 5000 });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("installed smoke selects pinned executable outputs, not multi-output defaults or the first man path", () => {
  const matrix = fileURLToPath(new URL("../../../../scripts/axi-smoke/matrix.py", import.meta.url));
  const result = spawnSync("python3", ["-B", "-c", `
import importlib.util, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("axi_matrix", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    out, man = root / "out", root / "man"
    (out / "bin").mkdir(parents=True)
    man.mkdir()
    matrix = module.Matrix.__new__(module.Matrix)
    matrix.url = "git+file:///synthetic-checkout?submodules=1"
    expressions = []
    def build(expression):
        expressions.append(expression)
        # Model the default man-before-out result: only explicit .out may
        # resolve to the executable tree, never the first default output.
        return str(out if expression.endswith(".out") else man)
    matrix.build = build
    for name, executable in (("strace", "strace"), ("bubblewrap", "bwrap")):
        binary = out / "bin" / executable
        binary.write_text("#!/bin/sh\\nexit 0\\n")
        binary.chmod(0o700)
        assert matrix.inspection_binary(name) == str(binary)
        assert expressions[-1].endswith("." + name + ".out")
        binary.chmod(0o600)
        try:
            matrix.inspection_binary(name)
        except AssertionError:
            pass
        else:
            raise AssertionError("non-executable inspection tool accepted")
        binary.unlink()
        try:
            matrix.inspection_binary(name)
        except AssertionError:
            pass
        else:
            raise AssertionError("missing inspection tool accepted")
    assert len(expressions) == 6
`, matrix], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});

test("installed wrapper capture uses declared Bash semantics and rejects unsupported interpreters", async () => {
  const helper = new URL("../../../../scripts/axi-smoke/capture-wrapper.mjs", import.meta.url);
  const { captureInstalledWrapper } = await import(helper.href);
  const shell = "/nix/store/00000000000000000000000000000000-bash-fixture/bin/bash";
  const dir = mkdtempSync(join(tmpdir(), "axi-wrapper-capture-"));
  mkdirSync(join(dir, "bin"));
  const wrapper = join(dir, "bin", "ppa");
  try {
    writeFileSync(wrapper, `#! ${shell} -e\nexport PATH='/declared/bin:/inherited/bin::'\nexport PA_AXI_PATH='/selected/bin'\nexec /nonexistent/never-run --help\n`);
    let calls = 0;
    const effects = {
      readFileSync,
      spawnSync: (executable: string, args: string[], options: object) => {
        calls++;
        assert.equal(executable, shell);
        assert.deepEqual(args.slice(0, 4), ["--noprofile", "--norc", "-e", "-c"]);
        // Exercise the exact capture primitive with real Bash, without Nix or
        // production wrapper execution; the declared fixture path is synthetic.
        return spawnSync("bash", args, { ...options, env: { PATH: process.env.PATH } });
      },
    };
    assert.deepEqual(captureInstalledWrapper(dir, "ppa", {}, effects), ["/declared/bin:/inherited/bin::", "/selected/bin"]);
    assert.equal(calls, 1);
    for (const shebang of ["#!/bin/sh", "#!/usr/bin/env bash", shell.replace("/bin/bash", "/bin/sh"), `#! ${shell} --posix`, `#! ${shell};touch /foreign`]) {
      writeFileSync(wrapper, shebang + "\nexec /nonexistent/never-run\n");
      assert.throws(() => captureInstalledWrapper(dir, "ppa", {}, effects));
    }
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("synthetic consent fixture safely rewrites intentional read-only modes and refuses symlinks", async () => {
  const helper = new URL("../../../../scripts/axi-smoke/consent-fixture.mjs", import.meta.url);
  const { writeConsentFixture } = await import(helper.href);
  const dir = mkdtempSync(join(tmpdir(), "axi-consent-fixture-"));
  const file = join(dir, "consent.json");
  try {
    for (const mode of [0o644, 0o400, 0o1600]) {
      writeConsentFixture(file, { version: 1 });
      chmodSync(file, mode);
      writeConsentFixture(file, { version: 2 });
      assert.equal(statSync(file).mode & 0o7777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 2 });
    }
    const link = join(dir, "link.json"); symlinkSync(file, link);
    assert.throws(() => writeConsentFixture(link, { version: 3 }));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("installed-smoke observer records actual credential/network/child attempts rather than assumed zero counters", () => {
  const dir = mkdtempSync(join(tmpdir(), "axi-smoke-observer-"));
  const ledger = join(dir, "events.jsonl");
  const profile = join(dir, "profiles", "codex");
  mkdirSync(profile, { recursive: true });
  const credential = join(profile, "synthetic.json");
  writeFileSync(credential, "synthetic-only");
  writeFileSync(ledger, "", { mode: 0o600 });
  const observer = fileURLToPath(new URL("../../../../scripts/axi-smoke/observe.cjs", import.meta.url));
  try {
    const probe = spawnSync(process.execPath, ["--require", observer, "--input-type=module", "--eval", `
      import { readFileSync } from 'node:fs';
      import { readFile } from 'node:fs/promises';
      import { request } from 'node:http';
      import { spawn } from 'node:child_process';
      readFileSync(process.env.PROBE_CREDENTIAL);
      await readFile(process.env.PROBE_CREDENTIAL);
      try { request('http://127.0.0.1:1/'); } catch {}
      try { spawn('/forbidden'); } catch {}
    `], { env: { AXI_SMOKE_ROOT: dir, AXI_SMOKE_LEDGER: ledger, PROBE_CREDENTIAL: credential }, encoding: "utf8", timeout: 5000 });
    assert.equal(probe.status, 0, probe.stderr);
    const events: { kind: string }[] = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
    assert.equal(events.filter((row) => row.kind === "observerLoaded").length, 1);
    assert.ok(events.filter((row) => row.kind === "credentialRead").length >= 2);
    assert.equal(events.filter((row) => row.kind === "unexpectedNetwork").length, 1);
    assert.equal(events.filter((row) => row.kind === "unexpectedSubprocess").length, 1);
    assert.equal(probe.stdout, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("daemon notices actual deployment lifecycle exit independently of idle and cleans state/descendants", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axi-browser-lifecycle-")); const f = fakeBrowser(root, "d-lifecycle");
  const lifecycle = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.once('data',()=>process.exit(0));"], { stdio: ["pipe", "ignore", "ignore"] });
  assert.ok(lifecycle.pid);
  const env = { ...f.env, PA_AXI_LIFECYCLE_PID: String(lifecycle.pid), PA_AXI_LIFECYCLE_START: processIdentity(lifecycle.pid) };
  const state = join(f.dir, "axi-browser");
  try {
    assert.equal(await runBrowserCommand({ ...f.input, env }), "browser ready\n");
    const pid = JSON.parse(readFileSync(join(state, "fixture-descendant.json"), "utf8")).pid as number;
    const before = performance.now(); lifecycle.stdin!.end("exit");
    await waitUntil(() => !existsSync(state));
    assert.ok(performance.now() - before < BROWSER_CLEANUP_MS);
    await waitUntil(() => processIdentity(pid) === undefined || readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z "));
    await cleanupManagedBrowser(env); // Cleanup is still legal after lifecycle exit.
  } finally { lifecycle.stdin!.end("exit"); try { await cleanupManagedBrowser(env); } catch { /* assertion captures failure */ } rmSync(root, { recursive: true, force: true }); }
});
