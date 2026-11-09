import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDb } from "../registry/db.js";
import { RegistryDocumentJournal } from "../registry/documents.js";
import { TicketStore } from "../tickets/store.js";
import { DocumentPackageService, type DocumentPackageHost } from "../documents/package-service.js";
import { documentPackageSha, type DocumentPackage } from "../documents/package-contract.js";
import { digest } from "../workflows/contracts.js";

export interface DocumentRuntimeFixture {
  root: string; repo: string; config: string; db: Database.Database; journal: RegistryDocumentJournal; store: TicketStore;
  subject: DocumentPackage; host: DocumentPackageHost; service: DocumentPackageService; sha256: string;
  call(input: Record<string, unknown>): Promise<Record<string, unknown>>; revision(): number; prepare(): Promise<string>; close(): void;
}
export function documentRuntimeFixture(): DocumentRuntimeFixture {
  const env = { ...process.env }, root = mkdtempSync(join(tmpdir(), "pa-documents-")), config = join(root, "config"), repo = join(root, "repo"), tickets = join(root, "tickets");
  mkdirSync(config); mkdirSync(repo); mkdirSync(tickets);
  writeFileSync(join(config, "config.yaml"), `repos:\n  example:\n    path: ${repo}\n    prefix: EX\n`);
  process.env.PA_PLATFORM_CONFIG = config;
  const db: Database.Database = getDb(join(root, "registry.db")), journal = new RegistryDocumentJournal(db), store = new TicketStore(tickets, { team: "requirements", mode: "analyze", privileged: true });
  writeFileSync(join(tickets, "EX-1.json"), JSON.stringify({ id: "EX-1", project: "example", title: "Synthetic document fixture", status: "requirement-review", assignee: "requirements/team-manager", doc_refs: [], comments: [], tags: [] }));
  const subject: DocumentPackage = { schemaVersion: "pa-document-package/v1", packageId: "example", revision: 1, repository: { key: "example", root: repo }, ticket: "EX-1", predecessor: null,
    members: (["brief", "requirements", "uat", "mockup", "contract"] as const).map(role => {
      const raw = Buffer.from(role === "brief" ? "A concise decision brief." : role === "requirements" ? "# FR-1 — test\n\n# AC-1 — test\nCoverage: TS-1\n" : role === "uat" ? "# TS-1 — test\nCoverage: FR-1, AC-1\n" : `# ${role}\nA supporting specification.\n`);
      const source = `agent-teams/requirements/artifacts/reviews/EX-1/r001/${role}.md`;
      mkdirSync(dirname(join(root, source)), { recursive: true }); writeFileSync(join(root, source), raw);
      return { id: role, role: ["mockup", "contract"].includes(role) ? "specification" : role as "brief" | "requirements" | "uat", mediaType: "text/markdown", source, description: role, bytes: raw.length, sha256: digest(raw) };
    }), references: [{ locator: "https://example.invalid/informative", version: "dated observation", description: "Never fetched or approved as specification" }], effects: { publish: true, queue: true, route: { team: "builder", mode: "orchestrator" } } };
  const nativeEvidence = Buffer.from("synthetic-native-evidence-not-human-acceptance");
  const host: DocumentPackageHost = { artifactRoot: root, tickets: store, authenticate: () => ({ deploymentId: "d-abcdef", repoKey: "example", repoRoot: repo, ticket: "EX-1", identitySha256: "a".repeat(64) }), assertEffectAvailable() {},
    capture: async () => ({ outcome: "approved", principal: "synthetic-source-test", evidenceSha256: digest(nativeEvidence), nativeEvidence }) };
  const service = new DocumentPackageService(journal, host), sha256 = documentPackageSha(subject);
  const call = (input: Record<string, unknown>) => service.execute(JSON.stringify(input));
  const revision = () => journal.events("example", "EX-1").length;
  const prepare = async () => {
    const frozen = await call({ action: "freeze", package: subject, expectedRevision: revision() });
    if (frozen.ok !== true) throw Error(JSON.stringify(frozen));
    const captured = await call({ action: "capture", sha256, expectedRevision: revision() });
    if (captured.ok !== true) throw Error(JSON.stringify(captured));
    const decision = (captured.result as { decisions: { decisionId: string }[] }).decisions.at(-1)!;
    return decision.decisionId;
  };
  return { root, repo, config, db, journal, store, subject, host, service, sha256, call, revision, prepare,
    close() { db.close(); process.env = env; rmSync(root, { recursive: true, force: true }); } };
}
