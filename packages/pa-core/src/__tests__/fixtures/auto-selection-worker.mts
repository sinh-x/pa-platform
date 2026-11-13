import { getDb } from "../../registry/db.js";
import { RegistryAutoJournal } from "../../auto/coordination.js";
import { routeAutoTicket } from "../../auto/waitlist.js";
const [path, project] = process.argv.slice(2), db = getDb(path!);
try {
  const e = routeAutoTicket({ id: project === "pa-platform" ? "PAP-1" : "PAPC-1", project: project as "pa-platform" | "pa-platform-config", title: "Synthetic", priority: "medium", status: "idea", createdAt: new Date().toISOString(), ticketSha256: "a".repeat(64), archived: false, unresolvedDependencies: [], blockingBulletins: [], competingDeployments: [], originalWorkflow: false, documents: { state: "missing" } });
  new RegistryAutoJournal(db).select(e, "/synthetic", () => e, () => {});
} catch { process.exitCode = 2; } finally { db.close(); }
