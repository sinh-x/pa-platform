import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AXI_VERSIONS, axiRuntimeEnvironment, runManagedAxi, type AxiPolicyEffects, type AxiTool, type ManagedAxiInvocation } from "../axi-policy.js";

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
    const f = fixture("chrome-devtools-axi", ["navigate", "http://fixture.test"], { PA_AXI_CHROME_EXECUTABLE: path });
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

test("present Chrome never produces placeholder operational success or launches a browser before Phase 3", () => {
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
      const result = spawnSync(process.execPath, [tsx, policy, tool, process.execPath, "/nonexistent/upstream.js", gh, ...args], {
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
