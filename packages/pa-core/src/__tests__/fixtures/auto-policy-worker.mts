import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getDb } from "../../registry/db.js";
import { RegistryDocumentJournal } from "../../registry/documents.js";
import { AutoDelegationPolicyService } from "../../documents/auto-policy.js";
import { digest } from "../../workflows/contracts.js";
const policy = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
const db = getDb(process.argv[2]!); let captures = 0;
// Real process/SQLite race with SIMULATED native UI/current-scope callbacks.
const host = { domain: digest(JSON.stringify(policy.domain)), authenticate: () => digest(`fixture-process:${process.pid}`), now: () => "2026-11-14T10:01:00.000Z", clock: () => ({ bootId: policy.clock.bootId, nowNs: "1060000000000" }), propose: () => policy, assertCurrent() {},
  async capture(r) { captures++; await new Promise(resolve => setTimeout(resolve, 50)); return Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-policy-native-review/v1", method: "ppa-auto-policy-foreground", reviewId: r.reviewId, decisionId: r.decisionId, operation: r.operation, policySha256: r.policySha256, target: r.target, principal: policy.domain.principal, interactionId: `interaction-${randomUUID()}`, outcome: "approved", boundary: "native-unmanaged-controlling-terminal-not-hostile-same-uid-isolation" })); } };
try { const result = await new AutoDelegationPolicyService(new RegistryDocumentJournal(db)).adopt(host); console.log(JSON.stringify({ decisionId: result.decisionId, captures })); }
catch { console.log(JSON.stringify({ blocked: true, captures })); process.exitCode = 2; }
finally { db.close(); }
