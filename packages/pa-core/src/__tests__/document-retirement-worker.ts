// Disposable source worker; synthetic native consent is NOT installed/operator evidence.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentPackageService } from "../documents/package-service.js";
import { getDb } from "../registry/db.js";
import { RegistryDocumentJournal } from "../registry/documents.js";
import { TicketStore } from "../tickets/store.js";
import { digest } from "../workflows/contracts.js";

const [root, raw, crash] = process.argv.slice(2);
if (!root || !raw) throw Error("invalid disposable worker input");
process.env.PA_PLATFORM_CONFIG = join(root, "config");
const request = JSON.parse(raw), db = getDb(join(root, "registry.db")), journal = new RegistryDocumentJournal(db), subject = journal.subject(request.sha256);
const tickets = new TicketStore(join(root, "tickets"), { team: "requirements", mode: "analyze", privileged: true });
const append = journal.append.bind(journal);
journal.append = (...args) => {
  if (crash === "before-consent" && args[3].kind === "retirement-consent") process.exit(91);
  const event = append(...args);
  if (crash === "after-consent" && args[3].kind === "retirement-consent" || crash === "after-settlement" && args[3].kind === "retired") process.exit(91);
  return event;
};
const service = new DocumentPackageService(journal, { artifactRoot: root, tickets, recoveryProfile: true,
  authenticate: () => ({ deploymentId: "d-abcdef", repoKey: subject.repository.key, repoRoot: subject.repository.root, ticket: subject.ticket, identitySha256: "a".repeat(64), sessionId: "process-source-test" }),
  assertEffectAvailable() {}, capture: async () => { throw Error("no package capture"); },
  retire: async () => {
    appendFileSync(join(root, "prompts.txt"), "prompt\n");
    const nativeEvidence = Buffer.from("synthetic-process-consent");
    return { outcome: "approved", principal: "source-test", interactionId: `interaction-${process.pid}`, evidenceSha256: digest(nativeEvidence), nativeEvidence };
  },
});
const result = await service.execute(raw);
db.close(); process.stdout.write(JSON.stringify(result));
