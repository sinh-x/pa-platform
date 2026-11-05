import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDeployPaths } from "../deploy/paths.js";
import { resolveRepoExecutionPath } from "../repos.js";
import { beginAdvisoryRepositoryOperation, finishAdvisoryRepositoryOperation, withAdvisoryRepositoryOwner, type AdvisoryRepositoryContext } from "../deploy/repository-admission.js";
import { ProtectedWorkflowStore, workflowDigest } from "../deploy/prepared-workflow.js";
import { NativeExecutionEvidence } from "./evidence.js";
import { readAdvisoryStart } from "./runtime.js";
import type { AdvisoryOperationHost } from "./service.js";

/** Environment supplies locators ONLY. Current native registry, physical Git
 * identity, live runtime ancestry, lease and capacity must independently agree.
 * Unmarked/retained/ambiguous sessions are never upgraded. */
export function resolveAdvisoryOperationHost(runtime: "pi" | "opencode", cwd = process.cwd()): AdvisoryOperationHost | null {
  const id = process.env.PA_DEPLOYMENT_ID;
  if (!id) return null;
  const start = readAdvisoryStart(id);
  if (!start) return null;
  if (start.runtime !== runtime || start.team !== "builder" || cwd !== process.cwd() || start.worktree_root !== cwd || process.env.PA_DEPLOYMENT_DIR !== getDeployPaths(id).deployDir) throw new Error("ADVISORY_CALLER_UNPROVEN");
  const physical = resolveRepoExecutionPath(undefined, cwd, { allowLinkedWorktreeCwd: true });
  const context: AdvisoryRepositoryContext = { deploymentId: id, repoRoot: physical.repoRoot, worktreeRoot: physical.worktreeRoot };
  if (physical.repoRoot !== start.repo_root || physical.worktreeRoot !== start.worktree_root) throw new Error("ADVISORY_IDENTITY_CHANGED");
  const token = withAdvisoryRepositoryOwner(context, lease => {
    if (lease.deploymentDirectory !== getDeployPaths(id).deployDir) throw new Error("ADVISORY_IDENTITY_CHANGED");
    return lease.ownershipToken;
  });
  const root = join(getDeployPaths(id).deployDir, "operation-evidence");
  const locks = { repository: <T>(run: () => T): T => run(), worktree: <T>(run: () => T): T => withAdvisoryRepositoryOwner(context, () => run()) };
  let evidence: NativeExecutionEvidence | undefined;
  const host: AdvisoryOperationHost = {
    runtime, cwd,
    get evidence() {
      if (!evidence) withAdvisoryRepositoryOwner(context, () => {
        try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        evidence = new NativeExecutionEvidence(new ProtectedWorkflowStore(root), root, locks);
      });
      return evidence!;
    },
    privateValues: [token, ...Object.entries(process.env).filter(([key, value]) => /(?:token|secret|password|credential|api.?key|authorization)/i.test(key) && (value?.length ?? 0) >= 8).map(([, value]) => value!)],
    begin(operationId, command) {
      const intent = host.evidence.publish("advisory-operation-intent", { operationId, command, deploymentId: id, cwd });
      beginAdvisoryRepositoryOperation(context, { id: operationId, inputSha256: workflowDigest(command), intentRef: intent.ref });
      return intent;
    },
    beginObservation(operationId, command) {
      return host.evidence.publish("advisory-operation-intent", { operationId, command, deploymentId: id, cwd, readOnlyDiagnostic: true });
    },
    finishObservation(operationId, result, settled) {
      const observed = host.evidence.read(result, "advisory-process-result") as { operationId?: unknown; process?: { groupSettled?: unknown } };
      if (observed.operationId !== operationId || observed.process?.groupSettled !== settled) throw new Error("ADVISORY_OBSERVATION_UNPROVEN");
      withAdvisoryRepositoryOwner(context, () => undefined); // never clears/rewrites writer custody
    },
    finish(operationId, result, settled) {
      const observed = host.evidence.read(result, "advisory-process-result") as { operationId?: unknown; process?: { groupSettled?: unknown }; settled?: unknown };
      if (observed.operationId !== operationId || settled !== (observed.process?.groupSettled ?? observed.settled)) throw new Error("ADVISORY_SETTLEMENT_UNPROVEN");
      finishAdvisoryRepositoryOperation(context, operationId, settled);
    },
  };
  return host;
}
