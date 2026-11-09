// Disposable source-test worker. Never an installed/native human-decision producer.
import { join } from "node:path";
import { DocumentPackageService } from "../documents/package-service.js";
import { getDb } from "../registry/db.js";
import { RegistryDocumentJournal } from "../registry/documents.js";
import { TicketStore } from "../tickets/store.js";

const [root, sha256, decisionId, expected, action, crashAt] = process.argv.slice(2);
if (!root || !sha256 || !decisionId || !expected || !["publish", "queue"].includes(action!)) throw Error("invalid test worker");
process.env.PA_PLATFORM_CONFIG = join(root, "config");
const db = getDb(join(root, "registry.db")), journal = new RegistryDocumentJournal(db), subject = journal.subject(sha256);
const tickets = new TicketStore(join(root, "tickets"), { team: "requirements", mode: "analyze", privileged: true });
let updates = 0;
const update = tickets.update.bind(tickets);
tickets.update = (...args) => { const result = update(...args); updates++; if (String(updates) === crashAt) process.exit(91); return result; };
const service = new DocumentPackageService(journal, { artifactRoot: root, tickets, authenticate: () => ({ deploymentId: "d-abcdef", repoKey: subject.repository.key, repoRoot: subject.repository.root, ticket: subject.ticket, identitySha256: "b".repeat(64) }), assertEffectAvailable() {}, capture: async () => { throw Error("test worker must not capture"); } });
const result = await service.execute(JSON.stringify({ action, sha256, decisionId, expectedRevision: Number(expected) }));
db.close(); process.stdout.write(JSON.stringify(result));
