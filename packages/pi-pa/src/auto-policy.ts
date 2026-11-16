import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  AutoWaitlistError, AutoDelegationPolicyService, RegistryDocumentJournal, RegistryAutoShortlists, AUTO_POLICY_LIMITS, AUTO_POLICY_EFFECTS, AUTO_EXCLUDED_EFFECTS,
  parseAutoDelegationDefinition, parseAutoDelegationPolicy, parseReviewEvidenceJson, readArtifactFile, readProcessFingerprint, assertUnmanagedOperator,
  getAiUsageDir, getRegistryDbPath, resolveRepoExecutionPath, workflowDigest,
  type AutoDelegationPolicy, type NativeAutoPolicyHost, type DocumentAutoPolicyReview, type RegistryAutoJournal, type AutoItem, type AutoChoiceRecord,
} from "@pa-platform/pa-core";
import { selectedPiAutoDelegatedPair, type PiAutoDelegatedPair } from "./auto-delegated-contract.js";
import { selectedPiAutoShortlistPair, type PiAutoShortlistPair } from "./auto-shortlist-contract.js";
import { ProjectCommandContract } from "./project-command-contract.js";
import { readAutoGoalEvidence } from "./auto-goals.js";
import { nativeAutoTerminal, type AutoTerminal } from "./auto-terminal.js";

export interface AutoPolicyRuntime { sourceSha: string; configSha: string; packageVersion: string; storeRoot: string }
export interface PiAutoPolicyDependencies {
  /** Native embedding/test seams, NEVER CLI/JSON/environment permission flags. */
  runtime?: () => AutoPolicyRuntime; pair?: () => PiAutoDelegatedPair; shortlistPair?: () => PiAutoShortlistPair;
  authenticate?: () => string; now?: () => string; clock?: () => { bootId: string; nowNs: string };
  assertEffectsSupported?: () => void;
}
/** Installed identity observations only. No prepared-native v1 policy,
 * qualification or human promotion is reused as r003 authority. */
export function currentAutoPolicyRuntime(): AutoPolicyRuntime {
  const module = realpathSync(fileURLToPath(import.meta.url)), match = /^(\/nix\/store\/[a-z0-9]{32}-[^/]+)\/share\/pa-platform\/packages\/pi-pa\/dist\/auto-policy\.js$/.exec(module);
  if (!match) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); const storeRoot = match[1]!;
  const r = parseReviewEvidenceJson(readArtifactFile(join(storeRoot, "share/pa-platform/review-runtime-provenance.json"), 65536, "ARTIFACT_STALE"), "auto.policy.runtime") as Record<string, unknown>;
  const p = parseReviewEvidenceJson(readArtifactFile(join(storeRoot, "share/pa-platform/packages/pi-pa/package.json"), 65536, "ARTIFACT_STALE"), "auto.policy.package") as Record<string, unknown>;
  if (r.schemaVersion !== "pa-review-runtime/v1" || p.name !== "@pa-platform/pi-pa" || p.version !== r.packageVersion || !/^[a-f0-9]{40}$/.test(String(r.sourceSha)) || !/^[a-f0-9]{40}$/.test(String(r.configSha))) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  return { sourceSha: r.sourceSha as string, configSha: r.configSha as string, packageVersion: r.packageVersion as string, storeRoot };
}
export function piAutoPolicyDomain(): AutoDelegationPolicy["domain"] {
  const aiUsageRoot = getAiUsageDir(), registryPath = getRegistryDbPath();
  if (realpathSync(aiUsageRoot) !== aiUsageRoot || join(realpathSync(dirname(registryPath)), basename(registryPath)) !== registryPath) throw new AutoWaitlistError("AUTO_SOURCE");
  try { if (realpathSync(registryPath) !== registryPath) throw new AutoWaitlistError("AUTO_SOURCE"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return { aiUsageRoot, registryPath, principal: `local-uid:${userInfo().uid}` };
}
/** Actual native foreground capture. Policy JSON is displayed as full finite
 * scope, not as a receipt. Default/empty input is Cancel. */
export async function capturePiAutoPolicy(request: DocumentAutoPolicyReview, policy: AutoDelegationPolicy, terminal: AutoTerminal): Promise<Buffer> {
  terminal.authenticate();
  const displayed = Buffer.from(JSON.stringify(parseAutoDelegationPolicy(Buffer.from(JSON.stringify(policy)))));
  if (workflowDigest(displayed) !== request.policySha256) throw new AutoWaitlistError("AUTO_SOURCE");
  terminal.display(`Automatic policy ${request.operation}: review ${request.reviewId}.\nExact subject SHA-256: ${request.policySha256}. Target: ${request.target ?? "new policy"}.\nThis is NOT a ticket choice, human content/UAT approval, worker admission or service activation. No push/PR/merge/release/done/checkout return is included.\nFull exact policy:\n${JSON.stringify(policy, null, 2)}`);
  const prompt = request.operation === "adopt" ? "Adopt exactly this finite policy? Effect controls, qualification and each protected owner remain separate."
    : request.operation === "revoke" ? "Revoke this exact policy adoption? Stop new affected effects, without claiming process kill or cleanup."
      : "Withdraw ONLY this original unresolved review? Preserve its evidence and deny late issuance. A still-valid older policy may become eligible again; no effect is requested by withdrawal.";
  const selected = await terminal.choose(prompt, [request.operation === "adopt" ? "Adopt the exact displayed policy" : request.operation === "revoke" ? "Revoke the exact displayed adoption" : "Withdraw the displayed original review"]);
  terminal.authenticate(); const principal = `local-uid:${userInfo().uid}`, interactionId = `interaction-${randomUUID()}`;
  return Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-policy-native-review/v1", method: "ppa-auto-policy-foreground", reviewId: request.reviewId, decisionId: request.decisionId,
    operation: request.operation, policySha256: request.policySha256, target: request.target, principal, interactionId, outcome: selected === 0 ? "approved" : "cancelled",
    boundary: "native-unmanaged-controlling-terminal-not-hostile-same-uid-isolation" }));
}
export function createPiAutoPolicyHost(terminal: AutoTerminal = nativeAutoTerminal(), deps: PiAutoPolicyDependencies = {}): NativeAutoPolicyHost {
  const domain = piAutoPolicyDomain(), runtime = deps.runtime ?? currentAutoPolicyRuntime;
  const authenticate = deps.authenticate ?? (() => {
    assertUnmanagedOperator(); const facts = runtime(), fp = readProcessFingerprint(process.pid); if (!fp) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    return workflowDigest(JSON.stringify(["ppa-auto-policy-native/v1", domain, facts, fp]));
  });
  const now = deps.now ?? (() => new Date().toISOString()), clock = deps.clock ?? (() => {
    const fp = readProcessFingerprint(process.pid); if (!fp) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); return { bootId: fp.bootId, nowNs: process.hrtime.bigint().toString() };
  });
  const binding = () => {
    authenticate();
    if (!deps.assertEffectsSupported) throw Object.assign(new AutoWaitlistError("AUTO_UNAVAILABLE"), { policyGate: "effect-owner-bridge" });
    // Native embedding seam only. Production remains held until the actual
    // document/lifecycle/preparation/source/check/launcher bridge is installed.
    const support: unknown = deps.assertEffectsSupported();
    if (support instanceof Promise) void support.catch(() => {});
    if (support !== undefined) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
    const installed = runtime(), pair = (deps.pair ?? selectedPiAutoDelegatedPair)(), shortlist = (deps.shortlistPair ?? selectedPiAutoShortlistPair)();
    pair.assertCurrent(); shortlist.assertCurrent();
    if (pair.configRoot !== shortlist.configRoot || pair.configRevision !== shortlist.configRevision || pair.configRevision !== installed.configSha) throw new AutoWaitlistError("AUTO_SOURCE");
    const definition = parseAutoDelegationDefinition(pair.policyBytes);
    const repositories = definition.repositories.map(repo => {
      const resolved = resolveRepoExecutionPath(repo.key), profile = ProjectCommandContract.inspect(repo.key, resolved.repoRoot), paths = piAutoPolicyDomain();
      if ([paths.aiUsageRoot, paths.registryPath].some(path => path === resolved.repoRoot || path.startsWith(`${resolved.repoRoot}/`))) throw new AutoWaitlistError("AUTO_SOURCE");
      if (!profile) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
      const commands = repo.checkIds.map(id => { const check = profile.checks.find(c => c.id === id); if (!check) throw new AutoWaitlistError("AUTO_SOURCE"); return check.command; });
      return { key: repo.key, root: resolved.repoRoot, repositoryConfigSha256: workflowDigest(JSON.stringify(resolved.repo)), sourceScope: repo.sourceScope, checkProfileSha256: profile.sha256, commands };
    });
    const { instructions: _r, ...reasoning } = shortlist.reasoning, { instructions: _d, ...draft } = pair.draft;
    return { lifetimeSeconds: definition.lifetimeSeconds, subject: {
      domain: piAutoPolicyDomain(), runtime: { sourceSha: installed.sourceSha, packageVersion: installed.packageVersion, storeRoot: installed.storeRoot },
      pairing: { configRoot: pair.configRoot, configRevision: pair.configRevision, resourcesSha256: workflowDigest(JSON.stringify([pair.resourcesSha256, shortlist.resourcesSha256])), definitionSha256: workflowDigest(pair.policyBytes) },
      goalRules: { timezone: shortlist.timezone, sources: shortlist.goalSources }, repositories,
      roles: { reasoning, draft, implementation: pair.implementation }, limits: AUTO_POLICY_LIMITS, localEffects: [...AUTO_POLICY_EFFECTS], excludedEffects: [...AUTO_EXCLUDED_EFFECTS],
      guardrails: { repositoryProtection: "instruction-only" as const, cleanupScope: "observed-process-group-no-escaped-descendant-guarantee" as const, finalReview: "human-before-integration" as const },
    } };
  };
  return { domain: workflowDigest(JSON.stringify(domain)), authenticate, now, clock,
    propose() {
      const nativeClock = clock(), startedAt = now(), b = binding();
      return parseAutoDelegationPolicy(Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-delegation-policy/v1", policyId: `policy-${randomUUID()}`, ...b.subject,
        clock: { bootId: nativeClock.bootId, startedNs: nativeClock.nowNs }, createdAt: startedAt, expiresAt: new Date(Date.parse(startedAt) + b.lifetimeSeconds * 1000).toISOString() })));
    },
    assertCurrent(policy) {
      const b = binding(), { schemaVersion: _s, policyId: _id, clock: _clock, createdAt, expiresAt, ...subject } = policy;
      if (!isDeepStrictEqual(subject, b.subject) || Date.parse(expiresAt) - Date.parse(createdAt) !== b.lifetimeSeconds * 1000) throw new AutoWaitlistError("AUTO_SOURCE");
    },
    capture: (request, policy) => capturePiAutoPolicy(request, policy, terminal),
  };
}
/** Native authorization adapter, NOT an imported reference/boolean grant. The
 * current global adoption is resolved anew for every protected R2 callback.
 * Production continuation is intentionally not installed by this constructor. */
export const piAutoPolicyObservationSha = (base: PiAutoShortlistPair, reference: { decisionId: string; policySha256: string; expiresAt: string }): string =>
  workflowDigest(JSON.stringify(["pa-auto-policy-observation-scope/v1", base.observationScopeSha256, reference]));
/** For the future admitted r003 controller only. Retained observation-only
 * reports are not silently upgraded to adopted-policy reasoning. */
export function piAutoPolicyShortlistPair(documents: RegistryDocumentJournal, host: NativeAutoPolicyHost): PiAutoShortlistPair {
  const service = new AutoDelegationPolicyService(documents), admitted = service.authorize(host), base = selectedPiAutoShortlistPair();
  return { ...base, observationScopeSha256: piAutoPolicyObservationSha(base, admitted.reference),
    reasoning: { ...base.reasoning, instructions: `${base.reasoning.instructions}\nNative permitted finite scope, not a model-issued grant:\n${JSON.stringify(admitted)}` },
    assertCurrent() { base.assertCurrent(); service.authorize(host, admitted.reference); } };
}
export function piAutoDraftPolicyAuthority(journal: RegistryAutoJournal, host: NativeAutoPolicyHost) {
  const service = new AutoDelegationPolicyService(new RegistryDocumentJournal(journal.db)), shortlists = new RegistryAutoShortlists(journal.db);
  return { authenticate: () => host.authenticate(), authorizeDraft(item: AutoItem, choice: AutoChoiceRecord, reference?: { decisionId: string; policySha256: string; expiresAt: string }) {
    const admitted = service.authorize(host, reference, item.project), active = journal.active(), original = shortlists.selectionForItem(item.itemId), pair = selectedPiAutoShortlistPair();
    if (!original) throw new AutoWaitlistError("AUTO_SOURCE");
    const view = shortlists.published(original.viewVersion); if (view.sha256 !== original.viewSha256) throw new AutoWaitlistError("AUTO_SOURCE");
    const cycle = shortlists.cycle(view.cycleId);
    if (cycle.context.configSha256 !== pair.resourcesSha256 || cycle.context.policySha256 !== piAutoPolicyObservationSha(pair, admitted.reference)
      || cycle.context.goalSha256 !== workflowDigest(readAutoGoalEvidence(pair, new Date(host.now()), admitted.policy.domain.aiUsageRoot))) throw new AutoWaitlistError("AUTO_SOURCE");
    if (realpathSync(journal.db.name) !== admitted.policy.domain.registryPath || !active || !isDeepStrictEqual(active, item) || !original || !isDeepStrictEqual(original, choice)) throw new AutoWaitlistError("AUTO_SOURCE");
    return admitted.reference;
  } };
}
