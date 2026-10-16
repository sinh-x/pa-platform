import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TreehouseClient, type TreehouseCommandResult } from "../treehouse.js";

function result(stdout: string | Buffer, status = 0): TreehouseCommandResult {
  return { status, stdout: Buffer.from(stdout), stderr: Buffer.from("PRIVATE-VERSION-STDERR") };
}

const free = { name: "1", path: "/tmp/pool/1/repo", status: "available", branch: "develop", flavor: "git", lease_id: "", lease_holder: "", leased_at: null, processes: [] };
const leased = { ...free, path: "/tmp/pool/2/repo", status: "leased", branch: "", detached: true, lease_id: "lease-2", lease_holder: "pa:repo:PAP-252", leased_at: "2026-10-16T00:00:00Z" };

test("exact version preflight rejects unsupported/malformed/error outputs before status or get", () => {
  for (const output of [
    result("v2.3.0\n"), result("v3.1.2\n"), result("v3.1.4\n"), result("v4.0.0\n"),
    result("v3.1.3\nPRIVATE-VERSION-STDOUT"), result("v3.1.3\0"), result(Buffer.from([0xc3])),
    result(Buffer.alloc(257, 0x20)), result(""), result("v3.1.3\n", 1),
    { ...result(""), status: null, error: new Error("ETIMEDOUT PRIVATE-VERSION-ERROR") },
  ]) {
    for (const action of ["status", "get", "acquire"] as const) {
      const calls: string[][] = [];
      const client = new TreehouseClient({ binary: "/fixture/treehouse", run: (args) => { calls.push([...args]); return output; } });
      assert.throws(() => action === "status" ? client.status("/repo") : action === "get" ? client.getLease("/repo", "pa:repo:PAP-252") : client.acquireOrReuse("/repo", "repo", "PAP-252"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /expected Treehouse v3\.1\.3; executable \/fixture\/treehouse; actual/);
        assert.match(error.message, /packaged PPA or nix develop/);
        assert.doesNotMatch(error.message, /PRIVATE-VERSION/);
        assert.ok(error.message.length <= 2000);
        return true;
      });
      assert.deepEqual(calls, [["--version"]]);
    }
  }
});

test("preflight repeats before allocation and preserves pool on version drift", () => {
  const calls: string[][] = [];
  let probes = 0;
  const client = new TreehouseClient({ run: (args) => {
    calls.push([...args]);
    return args[0] === "--version" ? result(++probes === 1 ? "v3.1.3\n" : "v3.1.4\n") : result(JSON.stringify([free]));
  } });
  assert.throws(() => client.acquireOrReuse("/repo", "repo", "PAP-252"), /actual v3.1.4/);
  assert.deepEqual(calls, [["--version"], ["status", "--json"], ["--version"]]);
});

test("v3.1.3 empty/free/leased/mixed pools and base_branch allocation", () => {
  for (const rows of [[], [free], [leased], [free, leased]]) {
    let gets = 0;
    const client = new TreehouseClient({ run: (args) => args[0] === "--version" ? result("v3.1.3\n") : args[0] === "status" ? result(JSON.stringify(rows)) : (gets++, result(JSON.stringify({ path: leased.path, lease_id: leased.lease_id, lease_holder: leased.lease_holder, leased_at: leased.leased_at, base_branch: "develop" }))) });
    assert.equal(client.status("/repo").length, rows.length);
    assert.equal(client.acquireOrReuse("/repo", "repo", "PAP-252").leaseId, leased.lease_id);
    assert.equal(gets, rows.includes(leased) ? 0 : 1);
  }
});

test("v3 branch/detached/recovery fields are typed and unknown fields still reject", () => {
  for (const row of [free, leased, { ...free, branch: "", branch_error: "unreadable" }, { ...leased, recovery_reason: "quarantined", recovery_backup: "/tmp/backup" }]) {
    const client = new TreehouseClient({ run: (args) => result(args[0] === "--version" ? "v3.1.3\n" : JSON.stringify([row])) });
    assert.equal(client.status("/repo").length, 1);
  }
  for (const extra of [{ branch: 7 }, { detached: "yes" }, { branch_error: false }, { recovery_reason: [] }, { recovery_backup: null }, { branch: "bad\0" }, { branch: "develop", detached: true }, { new_field: true }]) {
    let gets = 0;
    const client = new TreehouseClient({ run: (args) => { if (args[0] === "get") gets++; return result(args[0] === "--version" ? "v3.1.3\n" : JSON.stringify([{ ...free, ...extra }])); } });
    assert.throws(() => client.acquireOrReuse("/repo", "repo", "PAP-252"), /unexpected|contradictory/);
    assert.equal(gets, 0);
  }
  for (const extra of [{ base_branch: false }, { base_branch: "bad\0" }, { status: "available" }, { unknown: 1 }]) {
    const client = new TreehouseClient({ run: (args) => result(args[0] === "--version" ? "v3.1.3\n" : JSON.stringify({ path: leased.path, lease_id: leased.lease_id, lease_holder: leased.lease_holder, ...extra })) });
    assert.throws(() => client.getLease("/repo", leased.lease_holder), /unexpected|contradicts/);
  }
});

test("real executable preflight is read-only and uses explicit binary instead of PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "pap252-version-"));
  const prior = process.env["PA_TREEHOUSE_BINARY"];
  try {
    const binary = join(root, "treehouse");
    writeFileSync(binary, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "v3.1.3\\n"; else printf "[]\\n"; fi\n');
    chmodSync(binary, 0o755);
    process.env["PA_TREEHOUSE_BINARY"] = binary;
    assert.deepEqual(new TreehouseClient().status(root), []);
    writeFileSync(binary, '#!/bin/sh\nprintf "v2.3.0\\n"\n');
    assert.throws(() => new TreehouseClient().getLease(root, "pa:repo:PAP-252"), /actual v2.3.0/);
    assert.throws(() => new TreehouseClient({ binary: join(root, "missing") }).status(root), /unavailable executable/);
  } finally {
    if (prior === undefined) delete process.env["PA_TREEHOUSE_BINARY"]; else process.env["PA_TREEHOUSE_BINARY"] = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
