import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeRemoteUrl, resolveRepoByRemoteIdentity } from "../repos.js";

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
