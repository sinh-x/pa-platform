import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDirectContract, directBuilderProfile, directContracts, type DirectContract } from "./builder-instruction-contract.js";

for (const kind of Object.keys(directContracts) as DirectContract[]) {
  test(`direct-only ${kind} requires every boundary and rejects implementation fallback`, () => {
    const clauses: readonly string[] = directContracts[kind];
    const body = clauses.join("\n");
    assert.doesNotThrow(() => assertDirectContract(kind, body));
    for (let index = 0; index < clauses.length; index++) {
      assert.throws(() => assertDirectContract(kind, clauses.filter((_, row) => row !== index).join("\n")), /missing/);
    }
    for (const bad of ["--mode implement", "Delegate the fix to `builder/implement`", "Skip independent review", "Unknown checks pass", "Reset exhausted counters"]) {
      assert.throws(() => assertDirectContract(kind, `${body}\n${bad}`));
    }
  });
}

test("builder instruction profile accepts exact split/direct shapes, never unknown/mixed or ticketless direct", () => {
  const root = mkdtempSync(join(tmpdir(), "pap302-builder-profile-"));
  mkdirSync(join(root, "teams"));
  const set = (defaultMode: string, ids: string[], ticket: boolean) => writeFileSync(join(root, "teams/builder.yaml"),
    `name: builder\ndefault_mode: ${defaultMode}\nagents: []\ndeploy_modes:\n${ids.map(id => `  - id: ${id}\n    provider: openai\n    model: openai/test\n    require_ticket: ${ticket}\n`).join("")}`);
  try {
    set("implement", ["implement", "orchestrator"], true); assert.equal(directBuilderProfile(root), false);
    set("orchestrator", ["orchestrator", "worker"], true); assert.equal(directBuilderProfile(root), true);
    for (const [mode, ids, ticket] of [["orchestrator", ["orchestrator", "implement"], true], ["unknown", ["orchestrator"], true], ["implement", ["worker"], true], ["orchestrator", ["orchestrator"], false]] as const) {
      set(mode, [...ids], ticket); assert.throws(() => directBuilderProfile(root));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
