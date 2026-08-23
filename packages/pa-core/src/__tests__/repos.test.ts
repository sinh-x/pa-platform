import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadReposYaml, normalizeRemoteUrl, resolveRepoByRemoteIdentity } from "../repos.js";

test("normalizes equivalent SSH and HTTPS GitHub remotes", () => {
  const urls = [
    "git@github.com:sinh-x/pa-platform.git",
    "https://github.com/sinh-x/pa-platform",
    "https://github.com/sinh-x/pa-platform/",
    "ssh://git@github.com/sinh-x/pa-platform.git",
  ];
  assert.deepEqual(new Set(urls.map(normalizeRemoteUrl)), new Set(["github.com/sinh-x/pa-platform"]));
});

test("keeps host and repository path distinct during normalization", () => {
  assert.notEqual(normalizeRemoteUrl("git@github.com:sinh-x/pa-platform.git"), normalizeRemoteUrl("git@gitlab.com:sinh-x/pa-platform.git"));
  assert.notEqual(normalizeRemoteUrl("git@github.com:sinh-x/pa-platform.git"), normalizeRemoteUrl("git@github.com:other/pa-platform.git"));
});

test("preserves non-default remote ports and omits default ports", () => {
  assert.equal(normalizeRemoteUrl("https://github.com:443/owner/project.git"), "github.com/owner/project");
  assert.equal(normalizeRemoteUrl("ssh://git@github.com:22/owner/project.git"), "github.com/owner/project");
  assert.equal(normalizeRemoteUrl("https://github.com:8443/owner/project.git"), "github.com:8443/owner/project");
  assert.notEqual(normalizeRemoteUrl("https://github.com:8443/owner/project.git"), normalizeRemoteUrl("https://github.com/owner/project.git"));
});

test("merges external and user config repository maps with user precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-config-"));
  const config = join(root, "config");
  const external = join(root, "external");
  mkdirSync(config);
  mkdirSync(external);
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  try {
    process.env["PA_PLATFORM_CONFIG"] = config;
    writeFileSync(join(config, "config.yaml"), `config_dir: ${external}\nrepos:\n  shared:\n    path: ${join(root, "user-shared")}\n    prefix: USER\n  user-only:\n    path: ${join(root, "user-only")}\n`);
    writeFileSync(join(external, "config.yaml"), `repos:\n  shared:\n    path: ${join(root, "external-shared")}\n    prefix: EXTERNAL\n  external-only:\n    path: ${join(root, "external-only")}\n`);

    assert.deepEqual(loadReposYaml(), {
      shared: { path: join(root, "user-shared"), prefix: "USER" },
      "user-only": { path: join(root, "user-only") },
      "external-only": { path: join(root, "external-only") },
    });
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves a unique remote and rejects duplicate identities", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-repos-"));
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const previous = process.env["PA_PLATFORM_CONFIG"];
  const previousHome = process.env["PA_PLATFORM_HOME"];
  process.env["PA_PLATFORM_CONFIG"] = root;
  process.env["PA_PLATFORM_HOME"] = root;
  writeFileSync(join(root, "config.yaml"), `repos:\n  first:\n    path: ${first}\n    remote_url: git@github.com:owner/project.git\n  second:\n    path: ${second}\n    remote_url: https://github.com/owner/other.git\n`);
  try {
    assert.equal(resolveRepoByRemoteIdentity("https://github.com/owner/missing"), null);
    assert.equal(resolveRepoByRemoteIdentity("https://github.com/owner/project/")?.name, "first");
    writeFileSync(join(root, "config.yaml"), `repos:\n  first:\n    path: ${first}\n    remote_url: git@github.com:owner/project.git\n  second:\n    path: ${second}\n    remote_url: https://github.com/owner/project.git\n`);
    assert.throws(() => resolveRepoByRemoteIdentity("https://github.com/owner/project"), /Ambiguous.*first.*second/);
  } finally {
    if (previous === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previous;
    if (previousHome === undefined) delete process.env["PA_PLATFORM_HOME"];
    else process.env["PA_PLATFORM_HOME"] = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
