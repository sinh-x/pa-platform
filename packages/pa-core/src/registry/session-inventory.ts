import { openReadonlyRegistryDatabase, readonlyRegistryFailure } from "./db.js";

/** Internal candidate metadata only. Public projections must omit repository paths. */
export interface SessionCandidate {
  deploymentId: string;
  ticket: string | null;
  team: string;
  mode: string | null;
  repositoryRoot: string | null;
  startedAt: string | null;
  registryStatus: string;
  candidatePid: number | null;
}
export const SESSION_CANDIDATE_LIMIT = 10_000;

/** Fresh existing-only read. No migrations, reconciliation, status filter or old list cap. */
export function readSessionCandidates(): { candidates: SessionCandidate[]; complete: boolean } {
  const db = openReadonlyRegistryDatabase(true);
  try {
    const rows = db.prepare(`SELECT deployment_id AS deploymentId, ticket_id AS ticket, team, mode,
      COALESCE(repo_root, repo) AS repositoryRoot, started_at AS startedAt, status AS registryStatus, pid AS candidatePid
      FROM deployments WHERE runtime = 'pi' AND binary = 'ppa'
      ORDER BY started_at DESC, deployment_id LIMIT ?`).all(SESSION_CANDIDATE_LIMIT + 1) as SessionCandidate[];
    return { candidates: rows.slice(0, SESSION_CANDIDATE_LIMIT), complete: rows.length <= SESSION_CANDIDATE_LIMIT };
  } catch (error) { throw readonlyRegistryFailure(error); }
  finally { db.close(); }
}
