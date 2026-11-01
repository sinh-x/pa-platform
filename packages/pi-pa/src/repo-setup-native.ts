import {
  getDeployPaths, MAX_REPO_SETUP_REQUEST_BYTES, queryReadonlyDeploymentStatuses, queryReadonlyRepoSetupLaunch, readProcessFingerprint,
  repoSetupService, RepoSetupError, resolveRepoExecutionPath, type RepoSetupHost,
} from "@pa-platform/pa-core";
import { readPiProcessIdentity } from "./process-identity.js";

/** Current-process native host only, not a subprocess approval CLI. No caller
 * actor/root/process/capability options are accepted. Registry and immutable
 * launch incarnation are reread on EVERY service boundary, including publish.
 */
export function piRepoSetupHost(context: unknown): RepoSetupHost {
  return { authenticate() {
    try {
      const env = process.env, id = env.PA_DEPLOYMENT_ID;
      if (!id || !/^d-[0-9a-f]{6}$/.test(id) || (context as { cwd?: string } | null)?.cwd !== process.cwd()) throw new RepoSetupError("SETUP_ACTOR");
      const status = queryReadonlyRepoSetupLaunch(id);
      if (!status || status.status !== "running" || status.pid !== process.pid || status.team !== "repo-setup" || status.mode !== "setup"
        || status.runtime !== "pi" || status.binary !== "ppa" || status.invocation_channel !== "cli" || status.ticket_id
        || status.rogue_one || status.parent_deployment_id || status.builder_authority || status.repository_slot || status.ticket_slot_id
        || status.repository_permit || status.treehouse_path || status.ticket_worktree_selection || status.review_checkout || status.resumed_from_deployment_id
        || env.PA_TEAM !== status.team || env.PA_MODE !== status.mode || env.PA_TICKET_ID || env.PA_ROGUE_ONE
        || env.PA_DEPLOYMENT_DIR !== getDeployPaths(id).deployDir) throw new RepoSetupError("SETUP_ACTOR");
      const anchor = readPiProcessIdentity(id, env.PA_DEPLOYMENT_DIR);
      if (anchor.pid !== process.pid || JSON.stringify(anchor) !== JSON.stringify(readProcessFingerprint(process.pid))) throw new RepoSetupError("SETUP_ACTOR");
      const repo = resolveRepoExecutionPath(undefined, process.cwd());
      if (repo.worktreeKind !== "primary" || repo.repoRoot !== process.cwd() || repo.worktreeRoot !== repo.repoRoot || env.PA_REPO !== repo.repoRoot
        || env.PA_WORKTREE_ROOT !== repo.repoRoot || status.repo !== repo.repoRoot || status.repo_root !== repo.repoRoot || status.worktree_root !== repo.repoRoot) throw new RepoSetupError("SETUP_REPOSITORY");
      // Unknown/stale foreground sessions are not automatically terminal. Even
      // non-locking writers (including rogue-one) cannot be silently overlapped.
      if (queryReadonlyDeploymentStatuses().some(other => other.deploy_id !== id && ["running", "dead", "unknown"].includes(other.status)
        && (other.repo_root === repo.repoRoot || other.repo === repo.repoRoot || other.worktree_root === repo.repoRoot))) throw new RepoSetupError("SETUP_BUSY");
      return { key: repo.repoKey, root: repo.repoRoot };
    } catch (error) { if (error instanceof RepoSetupError) throw error; throw new RepoSetupError("SETUP_ACTOR"); }
  } };
}
export function mutatePiRepoSetup(input: Record<string, unknown>, context: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.request !== "string"
    || Buffer.byteLength(input.request) > MAX_REPO_SETUP_REQUEST_BYTES) return { ok: false, error: { code: "SETUP_REQUEST" }, executionReady: false };
  return repoSetupService(input.request, piRepoSetupHost(context));
}
