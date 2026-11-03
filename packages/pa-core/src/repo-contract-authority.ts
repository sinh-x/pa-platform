import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ProtectedWorkflowStore, withPreparedWorkflowLocks, workflowDigest, workflowObject, type PreparedLockScope } from "./deploy/prepared-workflow.js";
import { withPreparedTicketCapacity } from "./deploy/ticket-concurrency.js";
import { withVacantRepositorySetup } from "./deploy/repository-admission.js";
import { inspectLocalProjectCommandCatalogue } from "./project-command-catalogue-files.js";
import { type CatalogueRepository, type ProjectCommandCatalogue, PROJECT_COMMAND_CATALOGUE_PATH } from "./project-command-catalogue.js";
import { loadRepoEntry, resolveRepoExecutionPath } from "./repos.js";
import { assertUnmanagedOperator } from "./operator-origin.js";
import { assertCatalogueIgnored, previewCatalogueExclude, reconcileCatalogueExclude, type LocalExcludeSnapshot } from "./repo-contract-git.js";

export type RepoOperatorCode = "REPO_OPERATOR_REQUIRED" | "REPO_CREDENTIAL_REQUIRED" | "REPO_CREDENTIAL_INVALID" | "REPO_APPROVAL_REQUIRED" | "REPO_APPROVAL_REVOKED" | "REPO_APPROVAL_STALE" | "REPO_APPROVAL_CONFLICT" | "REPO_AUTHORITY_IO";
export class RepoOperatorError extends Error { constructor(readonly code: RepoOperatorCode) { super(`Repository operator operation rejected: ${code}`); } }
const fail = (code: RepoOperatorCode): never => { throw new RepoOperatorError(code); };
const digest = (value: unknown) => workflowDigest(JSON.stringify(value));
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const CREDENTIAL = workflowDigest("repo-operator-credential/v1");
interface Credential { schemaVersion: "repo-operator-credential/v1"; sequence: number; previousSha256: string | null; operation: "init" | "rotate" | "reset"; epoch: string; salt: string; verifier: string; recordedAt: string }
interface Approval { schemaVersion: "native-repo-contract/v1"; sequence: number; previousSha256: string | null; repository: CatalogueRepository; action: "approve" | "revoke"; catalogueSha256: string; epoch: string; recordedAt: string }
export interface RepoContractPreview { readonly repository: CatalogueRepository; readonly catalogue: ProjectCommandCatalogue; readonly exclude: LocalExcludeSnapshot }
export interface ApprovedProjectCatalogue { readonly catalogue: ProjectCommandCatalogue; readonly approvalSha256: string }
/** Trusted embedding fixtures only. No public path/clock/actor/result override. */
export interface RepoAuthorityDependencies { root?: string; assertOperator?: () => void; now?: () => string }
function name(id: string, sequence: number): string { return sequence === 1 ? `${id}.intent.json` : `${id}.transaction-${sequence - 1}.json`; }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> { try { return workflowObject(value, fields); } catch { return fail("REPO_AUTHORITY_IO"); } }
function bootstrap(root: string): void {
  const missing: string[] = []; let part = root;
  while (true) {
    try { const stat = lstatSync(part); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(part) !== part) fail("REPO_AUTHORITY_IO"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing.push(part); part = dirname(part); }
  }
  for (const path of missing.reverse()) mkdirSync(path, { mode: 0o700 });
}
function secretValid(secret: Uint8Array): boolean {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 12 || secret.byteLength > 1024) return false;
  try { return !/[\u0000-\u001f\u007f-\u009f]/.test(new TextDecoder("utf-8", { fatal: true }).decode(secret)); } catch { return false; }
}
const derive = (secret: Uint8Array, salt: string) => scryptSync(secret, Buffer.from(salt, "hex"), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
/** One native owner/record chain per machine-local credential and repository.
 * Reuses the protected immutable native journal, not ticket paragraphs/config
 * grants/a second registration ledger. Same-UID storage trust is explicit.
 */
export class RepoContractAuthority {
  readonly root: string;
  readonly #assertOperator: () => void;
  readonly #now: () => string;
  constructor(dependencies: RepoAuthorityDependencies = {}) {
    this.root = dependencies.root ?? join(userInfo().homedir, ".local/share/pa-platform/prepared-autonomy/repository-contracts");
    this.#assertOperator = dependencies.assertOperator ?? assertUnmanagedOperator;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }
  #operator(): void { try { this.#assertOperator(); } catch { fail("REPO_OPERATOR_REQUIRED"); } }
  #store(create = false): ProtectedWorkflowStore | null {
    try { lstatSync(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("REPO_AUTHORITY_IO"); if (!create) return null; bootstrap(this.root); }
    try { return new ProtectedWorkflowStore(this.root); } catch { return fail("REPO_AUTHORITY_IO"); }
  }
  #chain(id: string): unknown[] {
    const store = this.#store(); if (!store) return [];
    try {
      const names = store.records().filter(item => item.startsWith(`${id}.`));
      if (names.length > 1000 || names.some(item => !Array.from({ length: names.length }, (_, i) => name(id, i + 1)).includes(item))) return fail("REPO_AUTHORITY_IO");
      const rows = names.map((_, index) => store.read(name(id, index + 1)));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, unknown>;
        if (row.sequence !== i + 1 || row.previousSha256 !== (i ? digest(rows[i - 1]) : null)
          || typeof row.recordedAt !== "string" || !Number.isFinite(Date.parse(row.recordedAt)) || row.recordedAt > this.#now()
          || (i && row.recordedAt < (rows[i - 1] as Record<string, string>).recordedAt!)) return fail("REPO_AUTHORITY_IO");
      }
      return rows;
    } catch (error) { if (error instanceof RepoOperatorError) throw error; return fail("REPO_AUTHORITY_IO"); }
  }
  #credential(): Credential | null {
    const rows = this.#chain(CREDENTIAL);
    for (let i = 0; i < rows.length; i++) {
      const row = object(rows[i], ["schemaVersion", "sequence", "previousSha256", "operation", "epoch", "salt", "verifier", "recordedAt"]);
      if (row.schemaVersion !== "repo-operator-credential/v1" || !hex(row.epoch) || !hex(row.salt) || !hex(row.verifier)
        || (!i ? row.operation !== "init" : !["rotate", "reset"].includes(String(row.operation)))) return fail("REPO_AUTHORITY_IO");
      if (i && ((row.operation === "rotate") !== (row.epoch === (rows[i - 1] as Credential).epoch))) return fail("REPO_AUTHORITY_IO");
    }
    return (rows.at(-1) as Credential | undefined) ?? null;
  }
  #verify(secret: Uint8Array, credential: Credential | null): Credential {
    if (!credential) return fail("REPO_CREDENTIAL_REQUIRED");
    if (!(secret instanceof Uint8Array) || secret.byteLength > 1024 || !timingSafeEqual(derive(secret, credential.salt), Buffer.from(credential.verifier, "hex"))) return fail("REPO_CREDENTIAL_INVALID");
    return credential;
  }
  #publish(scope: PreparedLockScope, id: string, sequence: number, value: unknown): void {
    if (sequence > 1000) fail("REPO_AUTHORITY_IO");
    try { this.#store(true)!.publish(scope, name(id, sequence), value); } catch { fail("REPO_AUTHORITY_IO"); }
  }
  credentialStatus(): { configured: boolean } { return { configured: this.#credential() !== null }; }
  configure(operation: "init" | "rotate" | "reset", secret: Uint8Array, old?: Uint8Array): void {
    this.#operator(); if (!["init", "rotate", "reset"].includes(operation) || !secretValid(secret)) return fail("REPO_CREDENTIAL_INVALID");
    const previous = this.#credential();
    if (operation === "init" ? previous !== null : previous === null) return fail("REPO_CREDENTIAL_INVALID");
    if (operation === "rotate") this.#verify(old ?? Buffer.alloc(0), previous);
    const salt = randomBytes(32).toString("hex");
    const row: Credential = { schemaVersion: "repo-operator-credential/v1", sequence: (previous?.sequence ?? 0) + 1, previousSha256: previous ? digest(previous) : null, operation,
      epoch: operation === "rotate" ? previous!.epoch : randomBytes(32).toString("hex"), salt, verifier: derive(secret, salt).toString("hex"), recordedAt: this.#now() };
    this.#operator(); if (!same(this.#credential(), previous)) return fail("REPO_APPROVAL_STALE");
    // Immutable no-clobber sequence publication is the global credential CAS;
    // reset races cannot upgrade an old-epoch approval. No expiry/delete/reclaim.
    withPreparedWorkflowLocks({ repository: run => run(), worktree: run => run() }, scope => this.#publish(scope, CREDENTIAL, row.sequence, row));
  }
  #repository(repo: CatalogueRepository): CatalogueRepository {
    const observed = resolveRepoExecutionPath(repo.key);
    if (observed.repoRoot !== repo.root || observed.worktreeRoot !== repo.root || loadRepoEntry(repo.key)?.projectCommands) return fail("REPO_APPROVAL_CONFLICT");
    return Object.freeze({ key: repo.key, root: repo.root });
  }
  #id(repo: CatalogueRepository): string { return digest(["native-repo-contract/v1", repo.key, repo.root]); }
  #approval(repo: CatalogueRepository): Approval | null {
    const rows = this.#chain(this.#id(repo));
    for (const value of rows) {
      const row = object(value, ["schemaVersion", "sequence", "previousSha256", "repository", "action", "catalogueSha256", "epoch", "recordedAt"]);
      const identity = object(row.repository, ["key", "root"]);
      if (row.schemaVersion !== "native-repo-contract/v1" || identity.key !== repo.key || identity.root !== repo.root || !["approve", "revoke"].includes(String(row.action)) || !hex(row.catalogueSha256) || !hex(row.epoch)) return fail("REPO_AUTHORITY_IO");
    }
    return (rows.at(-1) as Approval | undefined) ?? null;
  }
  preview(repository: CatalogueRepository): RepoContractPreview {
    this.#operator(); const repo = this.#repository(repository), catalogue = inspectLocalProjectCommandCatalogue(repo.key, repo.root);
    if (!catalogue) return fail("REPO_APPROVAL_REQUIRED");
    if (readdirSync(join(repo.root, ".pa")).some(name => /^\.pa-setup-.*\.tmp$/.test(name))) return fail("REPO_APPROVAL_CONFLICT");
    return Object.freeze({ repository: repo, catalogue, exclude: previewCatalogueExclude(repo) });
  }
  approve(preview: RepoContractPreview, secret: Uint8Array): string {
    this.#operator(); const credential = this.#verify(secret, this.#credential()), repo = this.#repository(preview.repository);
    if (!same(this.preview(repo), preview)) return fail("REPO_APPROVAL_STALE");
    return withPreparedTicketCapacity({ canonicalRepoKey: repo.key, canonicalRepoRoot: repo.root }, capacity =>
      withVacantRepositorySetup(repo.root, capacity, worktrees => {
        this.#operator();
        if (!same(this.#credential(), credential) || !same(this.preview(repo), preview)) return fail("REPO_APPROVAL_STALE");
        // A linked administrative source cannot be adopted by approving primary
        // bytes; no native owner creates or rewrites linked .pa data here.
        for (const root of worktrees.filter(root => root !== repo.root)) {
          try { lstatSync(join(root, PROJECT_COMMAND_CATALOGUE_PATH)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          return fail("REPO_APPROVAL_CONFLICT");
        }
        const previous = this.#approval(repo);
        reconcileCatalogueExclude(repo, preview.exclude);
        if (inspectLocalProjectCommandCatalogue(repo.key, repo.root)?.sha256 !== preview.catalogue.sha256 || !same(this.#credential(), credential)) return fail("REPO_APPROVAL_STALE");
        const row: Approval = { schemaVersion: "native-repo-contract/v1", sequence: (previous?.sequence ?? 0) + 1, previousSha256: previous ? digest(previous) : null,
          repository: repo, action: "approve", catalogueSha256: preview.catalogue.sha256, epoch: credential.epoch, recordedAt: this.#now() };
        this.#operator();
        withPreparedWorkflowLocks({ repository: run => run(), worktree: run => run() }, scope => this.#publish(scope, this.#id(repo), row.sequence, row));
        // A concurrently completed reset invalidates this issuance rather than
        // returning a misleading active result. Historical bytes stay retained.
        return this.approved(repo)!.approvalSha256;
      }));
  }
  revoke(repository: CatalogueRepository, secret: Uint8Array): void {
    this.#operator(); const repo = this.#repository(repository), credential = this.#verify(secret, this.#credential());
    withPreparedTicketCapacity({ canonicalRepoKey: repo.key, canonicalRepoRoot: repo.root }, () => {
      const previous = this.#approval(repo); if (!previous) return fail("REPO_APPROVAL_REQUIRED");
      if (!same(this.#credential(), credential)) return fail("REPO_APPROVAL_STALE");
      const row: Approval = { ...previous, sequence: previous.sequence + 1, previousSha256: digest(previous), action: "revoke", epoch: credential.epoch, recordedAt: this.#now() };
      this.#operator(); withPreparedWorkflowLocks({ repository: run => run(), worktree: run => run() }, scope => this.#publish(scope, this.#id(repo), row.sequence, row));
    });
  }
  /** Existing-only consumer. No terminal/credential verification/mutation and no
   * fallback through missing/revoked/drifted evidence or legacy registration.
   */
  approved(repository: CatalogueRepository): ApprovedProjectCatalogue | null {
    const previous = this.#approval(repository); if (!previous) return null;
    this.#repository(repository);
    if (previous.action === "revoke") return fail("REPO_APPROVAL_REVOKED");
    const credential = this.#credential(); if (!credential || credential.epoch !== previous.epoch) return fail("REPO_APPROVAL_REVOKED");
    const catalogue = inspectLocalProjectCommandCatalogue(repository.key, repository.root);
    if (!catalogue || catalogue.sha256 !== previous.catalogueSha256) return fail("REPO_APPROVAL_STALE");
    if (readdirSync(join(repository.root, ".pa")).some(name => /^\.pa-setup-.*\.tmp$/.test(name))) return fail("REPO_APPROVAL_CONFLICT");
    try { assertCatalogueIgnored(repository); } catch { return fail("REPO_APPROVAL_CONFLICT"); }
    return Object.freeze({ catalogue, approvalSha256: digest(previous) });
  }
}
export function inspectApprovedProjectCatalogue(repoKey: string, repoRoot: string): ApprovedProjectCatalogue | null {
  return new RepoContractAuthority().approved({ key: repoKey, root: repoRoot });
}
