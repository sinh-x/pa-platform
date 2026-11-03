import {
  getDeployPaths, MAX_REPO_SETUP_REQUEST_BYTES, queryReadonlyDeploymentStatuses, queryReadonlyRepoSetupLaunch, readProcessFingerprint,
  RegistryReadError, RepoSetupLaunchError, repoSetupRejection, repoSetupService, RepoSetupError, resolveRepoExecutionPath, type RepoSetupHost,
} from "@pa-platform/pa-core";
import { readPiProcessIdentity } from "./process-identity.js";

/** Current-process native host only, not a subprocess approval CLI. No caller
 * actor/root/process/capability options are accepted. Registry and immutable
 * launch incarnation are reread on EVERY service boundary, including publish.
 */
export function piRepoSetupHost(context: unknown): RepoSetupHost {
  return { authenticate() {
    const env = process.env, id = env.PA_DEPLOYMENT_ID;
    if (!id || !/^d-[0-9a-f]{6}$/.test(id) || (context as { cwd?: string } | null)?.cwd !== process.cwd()) throw new RepoSetupError("SETUP_ACTOR", "context-invalid");
    let status;
    try { status = queryReadonlyRepoSetupLaunch(id); }
    catch (error) {
      if (error instanceof RegistryReadError) throw new RepoSetupError("SETUP_REGISTRY", error.reason);
      if (error instanceof RepoSetupLaunchError) throw new RepoSetupError(error.reason === "launch-root" ? "SETUP_REPOSITORY" : "SETUP_ACTOR", error.reason);
      throw new RepoSetupError("SETUP_REGISTRY", "registry-unreadable");
    }
    // Strict raw launch validation above includes BOTH immutable and current
    // role/channel/custody evidence. Never infer CLI from a null historical row.
    if (status.pid !== process.pid) throw new RepoSetupError("SETUP_ACTOR", "process-pid");
    if (env.PA_TEAM !== status.team || env.PA_MODE !== status.mode || env.PA_TICKET_ID || env.PA_ROGUE_ONE
      || env.PA_DEPLOYMENT_DIR !== getDeployPaths(id).deployDir) throw new RepoSetupError("SETUP_ACTOR", "context-mismatch");
    try {
      const anchor = readPiProcessIdentity(id, env.PA_DEPLOYMENT_DIR);
      if (anchor.pid !== process.pid || JSON.stringify(anchor) !== JSON.stringify(readProcessFingerprint(process.pid))) throw new RepoSetupError("SETUP_ACTOR", "process-unverified");
    } catch { throw new RepoSetupError("SETUP_ACTOR", "process-unverified"); }
    let repo;
    try { repo = resolveRepoExecutionPath(undefined, process.cwd()); }
    catch { throw new RepoSetupError("SETUP_REPOSITORY", "repository-mismatch"); }
    if (repo.worktreeKind !== "primary" || repo.repoRoot !== process.cwd() || repo.worktreeRoot !== repo.repoRoot || env.PA_REPO !== repo.repoRoot
      || env.PA_WORKTREE_ROOT !== repo.repoRoot || status.repo !== repo.repoRoot || status.repo_root !== repo.repoRoot || status.worktree_root !== repo.repoRoot) throw new RepoSetupError("SETUP_REPOSITORY", "repository-mismatch");
    // Unknown/stale sessions are not automatically terminal. Even non-locking
    // writers cannot be silently overlapped. This reader is existing-files-only
    // too: overlap observation must not create SQLite coordination files.
    let others;
    try { others = queryReadonlyDeploymentStatuses(true); }
    catch (error) { throw new RepoSetupError("SETUP_REGISTRY", error instanceof RegistryReadError ? error.reason : "registry-unreadable"); }
    if (others.some(other => other.deploy_id !== id && ["running", "dead", "unknown"].includes(other.status)
      && (other.repo_root === repo.repoRoot || other.repo === repo.repoRoot || other.worktree_root === repo.repoRoot))) throw new RepoSetupError("SETUP_BUSY", "overlap-active-or-uncertain");
    return { key: repo.repoKey, root: repo.repoRoot };
  } };
}
export function mutatePiRepoSetup(input: Record<string, unknown>, context: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.request !== "string"
    || Buffer.byteLength(input.request) > MAX_REPO_SETUP_REQUEST_BYTES) return repoSetupRejection(new RepoSetupError("SETUP_REQUEST"));
  return repoSetupService(input.request, piRepoSetupHost(context));
}
