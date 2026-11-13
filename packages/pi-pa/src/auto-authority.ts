import {
  AutoWaitlistError, RegistryAutoJournal, RegistryDocumentJournal, AutoStartDecisionService, openReadonlyRegistryDatabase,
  queryDeploymentStatus, getDeploymentEvents, getDeployPaths, readProcessFingerprint, processIsWithinFingerprintLineage,
  autoMaterialTicketSha256, documentPending, TicketStore, type AutoStartIntent,
} from "@pa-platform/pa-core";
import { selectedPiAutoPair } from "./auto-contract.js";
import { readPiProcessIdentity } from "./process-identity.js";
import { isDeepStrictEqual } from "node:util";
import { ProjectCommandContract } from "./project-command-contract.js";

/** Source/check consumers call this AFTER their ordinary native custody checks.
 * Environment selects no grant: real registry, current process incarnation and
 * saved SAME dispatch lineage must all agree. A manual/foreign worker gains none. */
export function piAutoWorkerIntent(repoKey: string, repoRoot: string, ticket: string, branch: string): AutoStartIntent | null {
  const db = openReadonlyRegistryDatabase(true);
  try {
  const journal = new RegistryAutoJournal(db), item = journal.active();
  if (!item || item.project !== repoKey || item.repoRoot !== repoRoot || item.ticket !== ticket || !item.dispatch) return null;
  const id = process.env.PA_DEPLOYMENT_ID;
  if (id !== item.dispatch.deploymentId) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  const status = queryDeploymentStatus(id), start = getDeploymentEvents(id).find(e => e.event === "started"), current = readProcessFingerprint(process.pid), owner = status?.pid ? readProcessFingerprint(status.pid) : undefined;
  if (!status || !start || status.status !== "running" || status.runtime !== "pi" || status.team !== "builder" || status.mode !== "orchestrator"
    || status.rogue_one || status.ticket_id !== ticket || status.repo_root !== repoRoot || status.builder_authority !== "orchestrator" || !owner || !current || !processIsWithinFingerprintLineage(process.pid, owner)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  const anchor = readPiProcessIdentity(id, getDeployPaths(id).deployDir);
  if (!isDeepStrictEqual(anchor, owner)) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  const documents = new RegistryDocumentJournal(journal.db), decisions = new AutoStartDecisionService(documents, journal);
  const intent = decisions.authorize(item, {
    authenticate: () => { if (!readProcessFingerprint(process.pid)) throw new AutoWaitlistError("AUTO_UNAVAILABLE"); return `native-auto-worker:${id}`; },
    assertCurrent(currentItem, intent) {
      const pair = selectedPiAutoPair(), record = new TicketStore().get(ticket), profile = ProjectCommandContract.inspect(repoKey, repoRoot);
      if (!record || record.assignee !== "builder/team-manager" || !profile || profile.sha256 !== intent.validation.profileSha256 || autoMaterialTicketSha256(record) !== intent.materialTicketSha256 || intent.branch.name !== branch
        || pair.configRoot !== intent.configRoot || pair.configRevision !== intent.configRevision || pair.resourcesSha256 !== intent.configResourcesSha256
        || pair.implementation.provider !== intent.provider || pair.implementation.model !== intent.model || start.provider !== intent.provider || start.models?.team !== intent.model
        || currentItem.dispatch?.deploymentId !== id || documentPending(documents.events(repoKey, ticket)).length) throw new AutoWaitlistError("AUTO_SOURCE");
      pair.assertCurrent();
    },
  });
  return intent;
  } finally { db.close(); }
}
export function assertPiAutoScope(intent: AutoStartIntent, plan?: { paths: readonly string[]; checks: readonly string[] }): void {
  if (!plan) return;
  const scope = intent.sourceScope;
  if (plan.paths.some(path => !scope.files.includes(path) && !scope.newPaths.includes(path) && !scope.directories.some(dir => path.startsWith(`${dir}/`)))
    || plan.checks.some(command => !intent.validation.commands.includes(command))) throw new AutoWaitlistError("AUTO_UNAVAILABLE");
}
