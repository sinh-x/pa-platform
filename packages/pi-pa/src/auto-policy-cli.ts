import {
  AutoDelegationPolicyService, AutoWaitlistError, RegistryDocumentJournal, RegistryReadError, getDb, openReadonlyRegistryDatabase, workflowDigest,
  type NativeAutoPolicyHost,
} from "@pa-platform/pa-core";
import { createPiAutoPolicyHost, piAutoPolicyDomain } from "./auto-policy.js";
import { nativeAutoTerminal, type AutoTerminal } from "./auto-terminal.js";

export const AUTO_POLICY_USAGE = `Pi-only: ppa auto policy [status] [--json]
  ppa auto policy adopt|revoke|withdraw
  status    Existing-only native decision/scope inspection. Eligibility is not rechecked.
  adopt     Unmanaged foreground exact global-policy review, default Cancel.
  revoke    Unmanaged foreground removal of the exact issued policy, default Cancel.
  withdraw  Exceptional withdrawal of the original unresolved review, default Cancel.
No outcome/actor/policy-file/yes flags or receipt import. Managed/noninteractive input
cannot adopt, revoke or withdraw. Old manual receipts are unchanged. This command
never selects a ticket, starts a provider/worker, enables effects or installs services.
Policy adoption, qualification, per-effect admission and activation remain separate.`;
export function autoPolicyDiagnostic(input: "AUTO_BUSY" | "AUTO_SOURCE" | "AUTO_UNAVAILABLE" | "AUTO_INPUT" = "AUTO_UNAVAILABLE", gate?: "effect-owner-bridge"): string {
  const code = input === "AUTO_BUSY" || input === "AUTO_SOURCE" || input === "AUTO_INPUT" ? input : "AUTO_UNAVAILABLE";
  const reason = gate === "effect-owner-bridge" ? "This build has no admitted r003 document/lifecycle/preparation/source/check/launcher bridge. Full policy adoption remains held; configuration flags or another approval cannot supply that owner."
    : code === "AUTO_INPUT" ? "The command arguments are unsupported. No actor/outcome/yes/file flags or noninteractive permission capture are accepted."
    : code === "AUTO_BUSY" ? "An original review/evidence transition is unresolved or changed. No repeat of an unknown permission interaction is admitted."
    : code === "AUTO_SOURCE" ? "The exact native policy, capture or current scope could not be verified. Existing evidence remains."
      : "The required native foreground, storage, installed identity or current scope could not be established. The specific cause is unproven here.";
  return `Automatic policy review did not complete through this request.\nCondition: No new policy issuance is confirmed here. Any original native review and evidence remain.\nSource: PPA native policy decision and current-scope owners (${code}).\nReason: ${reason}\nCorrection:\n1. Inspect ppa auto policy status --json. Impact: read-only. Actor: agent or operator. New approval: not required. Prerequisite: supported candidate PPA inspection.\n2. Ask the native policy/runtime/configuration owner to reconcile the original review. Impact: none to ask. Actor: agent or operator. New approval: not required to ask; repairs need their own authority. Prerequisite: preserve original IDs.\nResume Action: Reconcile the SAME native request only after its owner establishes current scope and authority. Unknown permission capture is not reprompted. An explicit review withdrawal is exceptional, retains evidence and cannot issue the old grant. Any later effect is admitted separately.`;
}
export function readPiAutoPolicyStatus() {
  try {
    const db = openReadonlyRegistryDatabase(true);
    try { return new AutoDelegationPolicyService(new RegistryDocumentJournal(db)).status(workflowDigest(JSON.stringify(piAutoPolicyDomain()))); }
    finally { db.close(); }
  } catch (error) {
    return { schemaVersion: "pa-auto-policy-status/v1", observed: false, reason: error instanceof RegistryReadError && error.reason === "registry-missing" ? "not-initialized" : "unavailable",
      executionRequested: false, executionAdmitted: false, activationRequested: false };
  }
}
export interface PiAutoPolicyCliDependencies { terminal?: AutoTerminal; host?: NativeAutoPolicyHost; service?: AutoDelegationPolicyService }
export async function runPiAutoPolicyCommand(args: string[], io: { stdout(text: string): void; stderr(text: string): void }, deps: PiAutoPolicyCliDependencies = {}): Promise<number> {
  const json = args.includes("--json");
  try {
    if (args.length === 1 && args[0] === "--help") { io.stdout(AUTO_POLICY_USAGE); return 0; }
    if (args.reduce((n, a) => n + Buffer.byteLength(a), 0) > 65536) throw new AutoWaitlistError("AUTO_INPUT");
    const read = !args.length || args.join(" ") === "status" || args.join(" ") === "--json" || args.join(" ") === "status --json";
    if (read) {
      const state = readPiAutoPolicyStatus();
      if (json) io.stdout(JSON.stringify(state));
      else if (state.observed && "issuedAdoption" in state) io.stdout(`Native automatic policy: ${state.issuedAdoption ? `issued adoption ${state.issuedAdoption.decisionId}` : "no unretracted adoption recorded"}. Eligibility and effect admission were not rechecked.\nOriginal pending reviews: ${state.pendingReviews.length}. Use --json for exact scope and original IDs. No effect requested.`);
      else io.stderr(autoPolicyDiagnostic());
      return state.observed ? 0 : 1;
    }
    if (args.length !== 1 || !["adopt", "revoke", "withdraw"].includes(args[0]!)) throw new AutoWaitlistError("AUTO_INPUT");
    const terminal = deps.terminal ?? nativeAutoTerminal(); terminal.authenticate();
    const host = deps.host ?? createPiAutoPolicyHost(terminal); host.authenticate();
    if (args[0] === "adopt") host.propose(); // Validate supported native input before initialization; NOT issuance.
    const service = deps.service ?? new AutoDelegationPolicyService(new RegistryDocumentJournal(getDb()));
    const result = args[0] === "adopt" ? await service.adopt(host) : args[0] === "revoke" ? await service.revoke(host) : await service.withdraw(host);
    terminal.display(`Native policy ${result.operation}: ${result.outcome}. Original review ${result.reviewId}; decision ${result.decisionId}; policy SHA-256 ${result.policySha256}.\nNo ticket selected, provider/worker started or service enabled by this request. Qualification, controls and per-effect admission remain separate.`);
    return 0;
  } catch (error) {
    let code: "AUTO_BUSY" | "AUTO_SOURCE" | "AUTO_UNAVAILABLE" | "AUTO_INPUT" = "AUTO_UNAVAILABLE";
    try { const d = error instanceof AutoWaitlistError ? Object.getOwnPropertyDescriptor(error, "code") : undefined; if (d && "value" in d && (d.value === "AUTO_BUSY" || d.value === "AUTO_SOURCE" || d.value === "AUTO_INPUT")) code = d.value; } catch { /* no untrusted prose */ }
    let gate: "effect-owner-bridge" | undefined;
    try { const d = error instanceof AutoWaitlistError ? Object.getOwnPropertyDescriptor(error, "policyGate") : undefined; if (d && "value" in d && d.value === "effect-owner-bridge") gate = d.value; } catch { /* private finite gate only */ }
    if (json) io.stdout(JSON.stringify({ schemaVersion: "pa-auto-policy-status/v1", observed: false, code, ...(gate ? { policyGate: gate } : {}), executionRequested: false, executionAdmitted: false, activationRequested: false }));
    else io.stderr(autoPolicyDiagnostic(code, gate)); return 1;
  }
}
