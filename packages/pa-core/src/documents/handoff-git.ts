import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { withRepositoryRefAdmission } from "../deploy/repository-admission.js";
import { withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { readReviewEvidenceFile } from "../validation/review-contract.js";
import { getBranchPattern, loadRepoEntry } from "../repos.js";
import { digest, SHA256, text } from "../workflows/contracts.js";
import { documentReject } from "./package-contract.js";
import { handoffBranchIntentSha, parseHandoffBranchIntent, type HandoffBranchIntent } from "./handoff-contract.js";
import type { HandoffRefObservation } from "./handoff-branch.js";

/** Internal native Git adapter. Not a tool/profile or permission grant. Fresh
 * create only; historical/reuse lineage migration is deliberately unsupported.
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
  constructor(private readonly db: Database.Database) {
    // Original operation must be durable before any Git effect. Do not silently
    // weaken the connection's existing durability configuration.
    if (Number(db.pragma("synchronous", { simple: true })) < 2) documentReject("DOCUMENT_UNCERTAIN");
    db.exec("CREATE TABLE IF NOT EXISTS handoff_git_intents (operation_id TEXT PRIMARY KEY, binding TEXT NOT NULL, marker TEXT NOT NULL)");
  }
  withRepository<T>(rawIntent: HandoffBranchIntent, rawOperationId: string, run: (git: NativeHandoffGit) => T,
    boundary?: (point: HandoffGitBoundary) => void): T {
    const intent = parseHandoffBranchIntent(rawIntent), operationId = text(rawOperationId, SHA256);
    if (intent.action !== "create") documentReject("DOCUMENT_AUTHORITY");
    const binding = handoffBranchIntentSha(intent), ref = `refs/heads/${intent.branch}`;
    const registered = () => {
      const repo = loadRepoEntry(intent.repository.key);
      if (!repo || repo.path !== intent.repository.root || getBranchPattern(repo) !== "feature/<ticket>-<topic>" || (repo.developBranch ?? "develop") !== "develop") documentReject("DOCUMENT_AUTHORITY");
    };
    registered();
    const read = (): GitIntent | undefined => {
      const row = this.db.prepare("SELECT binding, marker FROM handoff_git_intents WHERE operation_id = ?").get(operationId) as GitIntent | undefined;
      if (row && (row.binding !== binding || !/^[a-f0-9]{64}(?![\s\S])/.test(row.marker))) documentReject("DOCUMENT_UNCERTAIN");
      return row;
    };
    return withRepositoryRefTicketExclusion(intent.repository.key, intent.repository.root, exclusion =>
      withRepositoryRefAdmission(intent.repository.root, exclusion, physicalIdentity => {
        if (physicalIdentity !== intent.repository.physicalIdentitySha256) documentReject("DOCUMENT_STALE");
        let active = true;
        const check = () => {
          if (!active) documentReject("DOCUMENT_AUTHORITY"); registered();
          if (Number(this.db.pragma("synchronous", { simple: true })) < 2) documentReject("DOCUMENT_UNCERTAIN");
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
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" };
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
            const marker = `pa-handoff:${operationId}:${original.marker}`;
            if (!log.endsWith("\n") || !first.startsWith(`${"0".repeat(40)} ${intent.base.sha} `) || first.slice(first.indexOf("\t") + 1) !== marker) return { state: "unknown" };
            return { state: "present", headSha, evidenceSha256: digest(JSON.stringify([binding, operationId, first])), owner: { kind: "operation", id: operationId } };
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
            check();
            const before = observe();
            if (before.state !== "absent" || before.history !== "never-created") documentReject("DOCUMENT_UNCERTAIN");
            storage();
            this.db.transaction(() => {
              if (read()) documentReject("DOCUMENT_UNCERTAIN");
              this.db.prepare("INSERT INTO handoff_git_intents (operation_id, binding, marker) VALUES (?, ?, ?)").run(operationId, binding, randomBytes(32).toString("hex"));
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
      }));
  }
}
