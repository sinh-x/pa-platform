// Disposable source-test worker; synthetic UI evidence, never real approval.
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getDb } from "../registry/db.js";
import { RegistryDocumentJournal } from "../registry/documents.js";
import { TicketStore } from "../tickets/store.js";
import { DocumentPackageService } from "../documents/package-service.js";
import { digest } from "../workflows/contracts.js";

const [root, sha256, expected, boundary] = process.argv.slice(2);
if (!root || !sha256 || !expected) throw Error("invalid disposable worker");
process.env.PA_PLATFORM_CONFIG = join(root, "config");
const db = getDb(join(root, "registry.db")), journal = new RegistryDocumentJournal(db), subject = journal.subject(sha256);
const tickets = new TicketStore(join(root, "tickets"), { team: "requirements", mode: "analyze", privileged: true });
const append = journal.append.bind(journal);
journal.append = (...args) => { const event = append(...args); if (boundary === "registry" && event.data.kind === "confirmation") process.exit(91); return event; };
const update = tickets.update.bind(tickets);
tickets.update = (...args) => { if (boundary === "file") process.exit(91); const value = update(...args); if (boundary === "reference") process.exit(91); return value; };
const comment = tickets.comment.bind(tickets);
tickets.comment = (...args) => { const value = comment(...args); if (boundary === "comment") process.exit(91); return value; };
const service = new DocumentPackageService(journal, { artifactRoot: root, tickets, workspaceProfile: true, confirmationProfile: true,
  authenticate: () => ({ deploymentId: "d-abcdef", repoKey: subject.repository.key, repoRoot: subject.repository.root, ticket: subject.ticket, identitySha256: "b".repeat(64), sessionId: "synthetic-confirmation-worker" }),
  assertEffectAvailable() {}, capture: async () => { throw Error("legacy capture forbidden"); }, confirm: async () => {
    const path = join(root, "native-ui-calls.txt"), calls = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0; writeFileSync(path, String(calls + 1));
    const nativeEvidence = Buffer.from("synthetic-native-confirmation-worker-not-human");
    return { outcome: "approved", principal: "synthetic-source-worker", interactionId: "interaction-worker", evidenceSha256: digest(nativeEvidence), nativeEvidence };
  },
});
const result = await service.execute(JSON.stringify({ action: "confirm", sha256, expectedRevision: Number(expected), scope: "content" }));
db.close(); process.stdout.write(JSON.stringify(result));
