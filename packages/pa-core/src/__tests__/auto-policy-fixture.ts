import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../registry/db.js";
import { RegistryDocumentJournal } from "../registry/documents.js";
import { AutoDelegationPolicyService, type NativeAutoPolicyHost } from "../documents/auto-policy.js";
import { AUTO_POLICY_LIMITS, AUTO_POLICY_EFFECTS, type AutoDelegationPolicy } from "../documents/auto-policy-contract.js";
import { AUTO_EXCLUDED_EFFECTS } from "../auto/intent.js";
import { digest } from "../workflows/contracts.js";
import { AutoWaitlistError } from "../auto/waitlist.js";
export interface AutoPolicyFixture {
  db: Database.Database; documents: RegistryDocumentJournal; service: AutoDelegationPolicyService; policy: AutoDelegationPolicy; host: NativeAutoPolicyHost;
  captures(): number; drift(): void; cancel(): void; actor(): void; time(at: string, ns?: string): void; boot(): void;
}
export function autoPolicyFixture(inputDb?: Database.Database): AutoPolicyFixture {
  const db: Database.Database = inputDb ?? getDb(":memory:");
  const documents = new RegistryDocumentJournal(db), service = new AutoDelegationPolicyService(documents);
  const policy: AutoDelegationPolicy = { schemaVersion: "pa-auto-delegation-policy/v1", policyId: `policy-${randomUUID()}`,
    domain: { aiUsageRoot: "/fixture/usage", registryPath: "/fixture/usage/registry.db", principal: "local-uid:42" }, runtime: { sourceSha: "a".repeat(40), packageVersion: "fixture-only", storeRoot: "/fixture/installed" },
    pairing: { configRoot: "/fixture/config", configRevision: "b".repeat(40), resourcesSha256: "c".repeat(64), definitionSha256: "d".repeat(64) },
    goalRules: { timezone: "UTC", sources: [{ pathTemplate: "daily/{date}.md", dateFormat: "iso", heading: "Focus" }] },
    repositories: (["pa-platform", "pa-platform-config"] as const).map(key => ({ key, root: `/fixture/${key}`, repositoryConfigSha256: "e".repeat(64), sourceScope: { files: ["README.md"], directories: [], newPaths: [] }, checkProfileSha256: "f".repeat(64), commands: ["project-command fixture-check"] })),
    roles: { reasoning: { team: "requirements", mode: "auto-reasoning", provider: "fixture", model: "fixture-model", objective: { path: "skills/reasoning.md", sha256: "a".repeat(64) } }, draft: { team: "requirements", mode: "auto-draft-delegated", provider: "fixture", model: "fixture-model", objective: { path: "skills/draft.md", sha256: "b".repeat(64) } }, implementation: { team: "builder", mode: "orchestrator", provider: "fixture", model: "fixture-model", objective: { path: "teams/builder.yaml", sha256: "c".repeat(64) } } },
    limits: { ...AUTO_POLICY_LIMITS }, localEffects: [...AUTO_POLICY_EFFECTS], excludedEffects: [...AUTO_EXCLUDED_EFFECTS], guardrails: { repositoryProtection: "instruction-only", cleanupScope: "observed-process-group-no-escaped-descendant-guarantee", finalReview: "human-before-integration" },
    clock: { bootId: "11111111-2222-3333-4444-555555555555", startedNs: "1000000000000" }, createdAt: "2026-11-14T10:00:00.000Z", expiresAt: "2026-11-14T11:00:00.000Z" };
  let now = "2026-11-14T10:01:00.000Z", nowNs = "1060000000000", allowed = true, captures = 0, outcome: "approved" | "cancelled" = "approved", identity = "1".repeat(64), bootId = policy.clock.bootId;
  const host: NativeAutoPolicyHost = { domain: digest(JSON.stringify(policy.domain)), authenticate: () => identity, now: () => now, clock: () => ({ bootId, nowNs }), propose: () => structuredClone(policy), assertCurrent() { if (!allowed) throw new AutoWaitlistError("AUTO_SOURCE"); },
    async capture(r) { captures++; return Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-policy-native-review/v1", method: "ppa-auto-policy-foreground", reviewId: r.reviewId, decisionId: r.decisionId, operation: r.operation, policySha256: r.policySha256, target: r.target, principal: policy.domain.principal, interactionId: `interaction-${randomUUID()}`, outcome, boundary: "native-unmanaged-controlling-terminal-not-hostile-same-uid-isolation" })); } };
  return { db, documents, service, policy, host, captures: () => captures, drift: () => { allowed = false; }, cancel: () => { outcome = "cancelled"; }, actor: () => { identity = "2".repeat(64); }, time: (at: string, ns = nowNs) => { now = at; nowNs = ns; }, boot: () => { bootId = "22222222-2222-3333-4444-555555555555"; } };
}
