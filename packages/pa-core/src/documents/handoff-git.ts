import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { withActiveRepositoryRefAdmission, withRepositoryRefAdmission, type RepositoryRefAdmission } from "../deploy/repository-admission.js";
import { withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { assertRegisteredHandoffPolicy } from "./handoff-policy.js";
import { loadRepoEntry } from "../repos.js";
import { digest, parseWorkflowRequest, SHA256, text } from "../workflows/contracts.js";
import { documentReject } from "./package-contract.js";
import { handoffBranchIntentSha, parseHandoffBranchIntent, type HandoffBranchIntent, type HandoffRepository } from "./handoff-contract.js";
import { RegistryHandoffBranchJournal, type HandoffRefObservation } from "./handoff-branch.js";

/** Internal native Git adapter. Not a tool/profile or permission grant. Reuse
 * requires a completed original creation with its exact native source/correlation;
 * missing historical source is never backfilled from matching names or SHAs.
 * All handles expire on lock release. Caller must recheck its actual new finite
 * decision/publication authority before create; locks alone do not authorize it. */
export interface NativeHandoffGit {
  observe(): HandoffRefObservation;
  create(): void;
  isAncestor(base: string, head: string): boolean;
}
interface GitIntent { binding: string; marker: string }
export type HandoffGitBoundary = "intent" | "ref" | "synced";
export class RegistryHandoffGitOwner {
  constructor(private readonly db: Database.Database, initialize = true) {
    // Original operation must be durable before any Git effect. Do not silently
    // weaken the connection's existing durability configuration.
    if (!db.readonly && Number(db.pragma("synchronous", { simple: true })) < 2) documentReject("DOCUMENT_UNCERTAIN");
    if (!initialize) return;
    db.exec("CREATE TABLE IF NOT EXISTS handoff_git_intents (operation_id TEXT PRIMARY KEY, binding TEXT NOT NULL, marker TEXT NOT NULL)");
    // Separate additive original-source record; never alter/backfill old intent
    // bytes. Both rows are committed atomically before a NEW ref creation.
    db.exec("CREATE TABLE IF NOT EXISTS handoff_git_creation_sources (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  }
  /** Discovery only: native saved creation plus completed original journal.
   * The caller MUST separately verify live ref/reflog/ancestry withRepository
   * under the same repository exclusion. Matching metadata is never proof. */
  creationForPlan(repository: HandoffRepository, ticket: string, branch: string) {
    const rows = this.db.prepare("SELECT operation_id, payload FROM handoff_git_creation_sources LIMIT 1025").all() as { operation_id: string; payload: string }[];
    if (rows.length > 1024) return documentReject("DOCUMENT_UNCERTAIN");
    const matches = rows.flatMap(row => {
      let original: HandoffBranchIntent;
      try { original = parseHandoffBranchIntent(parseWorkflowRequest(row.payload)); }
      catch { return documentReject("DOCUMENT_UNCERTAIN"); }
      if (original.ticket !== ticket || original.branch !== branch || original.repository.key !== repository.key) return [];
      text(row.operation_id, SHA256);
      if (original.action !== "create" || JSON.stringify(original.repository) !== JSON.stringify(repository)
        || new RegistryHandoffBranchJournal(this.db).events(row.operation_id).at(-1)?.kind !== "complete") return documentReject("DOCUMENT_UNCERTAIN");
      return [{ operationId: row.operation_id, intent: original }];
    });
    if (matches.length !== 1) return documentReject("DOCUMENT_UNCERTAIN");
    return matches[0]!;
  }
  withRepository<T>(rawIntent: HandoffBranchIntent, rawOperationId: string, run: (git: NativeHandoffGit) => T,
    boundary?: (point: HandoffGitBoundary) => void, admission?: RepositoryRefAdmission): T {
    return this.accessRepository(rawIntent, rawOperationId, run, boundary, admission, false);
  }
  /** Physical verification of saved effects, not admission for a remaining
   * write. The observation port has no create capability and still verifies
   * registered root, physical identity, storage, correlation and lineage. */
  observeRepository<T>(intent: HandoffBranchIntent, operationId: string, run: (git: Pick<NativeHandoffGit, "observe" | "isAncestor">) => T,
    admission?: RepositoryRefAdmission): T {
    return this.accessRepository(intent, operationId, port => run(Object.freeze({ observe: port.observe, isAncestor: port.isAncestor })), undefined, admission, true);
  }
  private accessRepository<T>(rawIntent: HandoffBranchIntent, rawOperationId: string, run: (git: NativeHandoffGit) => T,
    boundary: ((point: HandoffGitBoundary) => void) | undefined, admission: RepositoryRefAdmission | undefined, observationOnly: boolean): T {
    const intent = parseHandoffBranchIntent(rawIntent), operationId = text(rawOperationId, SHA256);
    const binding = handoffBranchIntentSha(intent), ref = `refs/heads/${intent.branch}`;
    const originId = intent.action === "reuse" ? intent.lineage!.operationSha256 : operationId;
    const registered = () => {
      if (!observationOnly) return assertRegisteredHandoffPolicy(intent.repository.key, intent.repository.root, intent.ticket, intent.branch);
      const repo = loadRepoEntry(intent.repository.key);
      if (!repo || repo.path !== intent.repository.root) documentReject("DOCUMENT_AUTHORITY");
    };
    registered();
    const read = (): GitIntent | undefined => {
      const row = this.db.prepare("SELECT binding, marker FROM handoff_git_intents WHERE operation_id = ?").get(originId) as GitIntent | undefined;
      const source = this.db.prepare("SELECT payload FROM handoff_git_creation_sources WHERE operation_id = ?").get(originId) as { payload: string } | undefined;
      if (!row) { if (source || intent.action === "reuse") documentReject("DOCUMENT_UNCERTAIN"); return undefined; }
      if (![row.binding, row.marker].every(value => /^[a-f0-9]{64}(?![\s\S])/.test(value)) || intent.action === "create" && row.binding !== binding) documentReject("DOCUMENT_UNCERTAIN");
      if (source) {
        let original: HandoffBranchIntent;
        try { original = parseHandoffBranchIntent(parseWorkflowRequest(source.payload)); } catch { return documentReject("DOCUMENT_UNCERTAIN"); }
        if (original.action !== "create" || handoffBranchIntentSha(original) !== row.binding || original.ticket !== intent.ticket || original.branch !== intent.branch
          || JSON.stringify(original.repository) !== JSON.stringify(intent.repository) || original.base.sha !== intent.base.sha) documentReject("DOCUMENT_UNCERTAIN");
      } else if (intent.action === "reuse") documentReject("DOCUMENT_UNCERTAIN");
      return row;
    };
    const admitted = (physicalIdentity: string): T => {
        if (physicalIdentity !== intent.repository.physicalIdentitySha256) documentReject("DOCUMENT_STALE");
        let active = true;
        const check = () => {
          if (!active) documentReject("DOCUMENT_AUTHORITY"); registered();
          if (!this.db.readonly && Number(this.db.pragma("synchronous", { simple: true })) < 2) documentReject("DOCUMENT_UNCERTAIN");
        };
        const storage = () => {
          for (const relative of [ref, `logs/${ref}`]) {
            let path = join(intent.repository.root, ".git");
            for (const [index, part] of relative.split("/").entries()) {
              path = join(path, part);
              try {
                const stat = lstatSync(path);
                if (stat.isSymbolicLink() || realpathSync(path) !== path || (index < relative.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) documentReject("DOCUMENT_SOURCE");
              } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
            }
          }
        };
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
        const git = (...argv: string[]) => {
          check();
          return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0",
            "-c", "core.logAllRefUpdates=true", "-c", "core.fsync=reference", "-c", "core.fsyncMethod=fsync",
            "-c", "user.name=PA handoff owner", "-c", "user.email=handoff@pa.invalid", ...argv],
          { cwd: intent.repository.root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 65536 }).trim();
        };
        if (git("rev-parse", "--show-ref-format") !== "files" || git("rev-parse", "--show-object-format") !== "sha1" || git("cat-file", "-t", intent.base.sha) !== "commit") documentReject("DOCUMENT_SOURCE");
        const observe = (): HandoffRefObservation => {
          check(); const original = read();
          try {
            storage();
            try { git("symbolic-ref", "--quiet", ref); return { state: "unknown" }; }
            catch (error) { if ((error as { status?: number }).status !== 1) return { state: "unknown" }; }
            try { git("show-ref", "--exists", ref); }
            catch (error) {
              if ((error as { status?: number }).status !== 2) return { state: "unknown" };
              if (!original) {
                // A leftover reflog is history, not proof this name was never
                // created. Do not append our marker to foreign/deleted history.
                try { lstatSync(join(intent.repository.root, ".git", "logs", ref)); return { state: "unknown" }; }
                catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") return { state: "unknown" }; }
              }
              return { state: "absent", history: original ? "uncertain" : "never-created" };
            }
            const headSha = git("show-ref", "--verify", "--hash", ref);
            if (!/^[a-f0-9]{40}(?![\s\S])/.test(headSha)) return { state: "unknown" };
            if (!original) return { state: "present", headSha, evidenceSha256: digest("unproven"), owner: { kind: "unproven" } };
            const raw = readReviewEvidenceFile(join(intent.repository.root, ".git", "logs", ref), 65536, "handoff creation correlation");
            const log = new TextDecoder("utf-8", { fatal: true }).decode(raw), first = log.split("\n")[0]!;
            const marker = `pa-handoff:${originId}:${original.marker}`;
            if (!log.endsWith("\n") || !first.startsWith(`${"0".repeat(40)} ${intent.base.sha} `) || first.slice(first.indexOf("\t") + 1) !== marker) return { state: "unknown" };
            const evidenceSha256 = digest(JSON.stringify([original.binding, originId, first]));
            if (intent.action === "reuse") {
              const completed = new RegistryHandoffBranchJournal(this.db).events(originId).at(-1);
              if (completed?.kind !== "complete" || completed.headSha !== intent.base.sha || completed.evidenceSha256 !== evidenceSha256
                || headSha !== intent.lineage!.observedHeadSha) return { state: "unknown" };
              try { git("merge-base", "--is-ancestor", intent.base.sha, headSha); } catch { return { state: "unknown" }; }
              return { state: "present", headSha, evidenceSha256, owner: { kind: "lineage", sha256: originId } };
            }
            return { state: "present", headSha, evidenceSha256, owner: { kind: "operation", id: operationId } };
          } catch { return { state: "unknown" }; }
        };
        const syncRef = () => {
          // Pin every generated ancestor; sync exact ref/reflog and all affected
          // directories. No extra correlation ref or checkout is created.
          for (const relative of [ref, `logs/${ref}`]) {
            let fd = openSync(join(intent.repository.root, ".git"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try {
              const parts = relative.split("/");
              for (const [index, part] of parts.entries()) {
                const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_NOFOLLOW | (index < parts.length - 1 ? constants.O_DIRECTORY : constants.O_NONBLOCK));
                try { fsyncSync(next); fsyncSync(fd); } catch (error) { closeSync(next); throw error; }
                closeSync(fd); fd = next;
              }
              fsyncSync(fd);
            } finally { closeSync(fd); }
          }
        };
        const port: NativeHandoffGit = Object.freeze({ observe,
          isAncestor(base: string, head: string) {
            if (![base, head].every(sha => /^[a-f0-9]{40}(?![\s\S])/.test(sha))) documentReject("DOCUMENT_INPUT");
            try { git("merge-base", "--is-ancestor", base, head); return true; } catch { return false; }
          },
          create: () => {
            check(); if (observationOnly || intent.action !== "create") documentReject("DOCUMENT_AUTHORITY");
            const before = observe();
            if (before.state !== "absent" || before.history !== "never-created") documentReject("DOCUMENT_UNCERTAIN");
            storage();
            this.db.transaction(() => {
              if (read()) documentReject("DOCUMENT_UNCERTAIN");
              this.db.prepare("INSERT INTO handoff_git_intents (operation_id, binding, marker) VALUES (?, ?, ?)").run(operationId, binding, randomBytes(32).toString("hex"));
              this.db.prepare("INSERT INTO handoff_git_creation_sources (operation_id, payload) VALUES (?, ?)").run(operationId, JSON.stringify(intent));
            }).immediate();
            boundary?.("intent");
            const original = read(); if (!original) documentReject("DOCUMENT_UNCERTAIN");
            git("update-ref", "--no-deref", "--create-reflog", "-m", `pa-handoff:${operationId}:${original!.marker}`, ref, intent.base.sha, "0".repeat(40));
            boundary?.("ref"); syncRef(); boundary?.("synced");
            const after = observe();
            if (after.state !== "present" || after.owner.kind !== "operation" || after.headSha !== intent.base.sha) documentReject("DOCUMENT_UNCERTAIN");
          },
        });
        try { const result = run(port); if (result && (typeof result === "object" || typeof result === "function") && "then" in result) documentReject("DOCUMENT_INPUT"); return result; }
        finally { active = false; }
      };
    // An opaque live owner permits composition inside TicketStore without
    // acquiring repository locks in reverse order. Forged/expired owners reject.
    return admission ? withActiveRepositoryRefAdmission(admission, intent.repository.root, admitted)
      : withRepositoryRefTicketExclusion(intent.repository.key, intent.repository.root, exclusion =>
        withRepositoryRefAdmission(intent.repository.root, exclusion, admitted));
  }
}
