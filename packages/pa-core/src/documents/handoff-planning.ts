import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withRepositoryRefAdmission } from "../deploy/repository-admission.js";
import { withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { getBranchPattern, loadRepoEntry } from "../repos.js";
import { creationDigest } from "../tickets/create-intent.js";
import type { TicketStore } from "../tickets/store.js";
import { SHA256, text } from "../workflows/contracts.js";
import { handoffBranchIntentSha, parseHandoffRequest, type HandoffBranchIntent } from "./handoff-contract.js";
import { intakeNativeHandoffTicket, type HandoffIntakeCaller, type HandoffIntakeHost } from "./handoff-intake.js";
import { DocumentPackageError, documentReject } from "./package-contract.js";

export interface NativeHandoffPlanningCaller extends HandoffIntakeCaller {
  identitySha256: string;
  ticket: string;
}
export interface NativeHandoffPlanningHost extends HandoffIntakeHost {
  authenticate(): NativeHandoffPlanningCaller;
}

/** Internal fresh-create composition, NOT selected tool grammar or authority.
 * Actual process/session and immutable selection authentication still belong to
 * the future native host. Existing intake admission rejects rogue/retained runs.
 * No public root/SHA/provenance/lineage/actor input and no ref/resource mutation.
 * Advanced native reuse remains with its existing correlated Git owner; this
 * first-create adapter must never adopt legacy links by name. */
export function planNativeHandoffTicket(store: TicketStore, host: NativeHandoffPlanningHost, rawRequest: string) {
  const request = parseHandoffRequest(rawRequest);
  if (request.action !== "plan") return documentReject("DOCUMENT_INPUT");
  const initial = structuredClone(host.authenticate());
  text(initial.identitySha256, SHA256);
  if (initial.ticket !== request.ticket) documentReject("DOCUMENT_AUTHORITY");
  const registered = () => {
    const repo = loadRepoEntry(initial.repoKey);
    if (!repo || repo.path !== initial.repoRoot || getBranchPattern(repo) !== "feature/<ticket>-<topic>"
      || (repo.developBranch ?? "develop") !== "develop") return documentReject("DOCUMENT_AUTHORITY");
    return repo;
  };
  registered();
  // Same native coordinates after response loss. No caller-chosen scope/root or
  // arbitrary recovery namespace; expectedVersion/branch are checked separately.
  const identity = { scope: creationDigest({ domain: "pa-handoff-plan/v1", deploymentId: initial.deploymentId, sessionId: initial.sessionId,
    identitySha256: initial.identitySha256, selectionSha256: initial.selectionSha256, repoKey: initial.repoKey, repoRoot: initial.repoRoot, ticket: initial.ticket }), requestId: request.requestId };
  return withRepositoryRefTicketExclusion(initial.repoKey, initial.repoRoot, exclusion =>
    withRepositoryRefAdmission(initial.repoRoot, exclusion, physicalIdentitySha256 => store.withWorkflowTransaction(() => {
      const current = () => {
        if (!isDeepStrictEqual(initial, host.authenticate())) documentReject("DOCUMENT_STALE");
        registered();
        // Reuse actual selected-start/current+historical association admission.
        // initial.ticket is non-null: this check cannot create/reassociate a ticket.
        return intakeNativeHandoffTicket(store, host, { ticket: request.ticket }).ticket;
      };
      current();
      const original = store.inspectHandoffWithIntent(identity);
      const repository = { key: initial.repoKey, root: initial.repoRoot, physicalIdentitySha256 };
      const ref = `refs/heads/${request.branch}`;
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
      const probe = (args: string[], absentStatus?: number): string | null => {
        try {
          return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args],
          { cwd: initial.repoRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 65536 }).trim();
        } catch (error) {
          if (absentStatus !== undefined && (error as { status?: number }).status === absentStatus) return null;
          return documentReject("DOCUMENT_UNCERTAIN");
        }
      };
      const git = (...args: string[]) => probe(args)!;
      // Inspect loose and packed storage without following aliases. Unknown Git
      // failures are not an absent branch; never return subprocess stderr/bodies.
      const storage = (relative: string) => {
        let path = join(initial.repoRoot, ".git");
        const parts = relative.split("/");
        for (const [index, part] of parts.entries()) {
          path = join(path, part);
          try {
            const stat = lstatSync(path);
            if (stat.isSymbolicLink() || realpathSync(path) !== path || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) documentReject("DOCUMENT_SOURCE");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
            if (error instanceof DocumentPackageError) throw error;
            documentReject("DOCUMENT_SOURCE");
          }
        }
      };
      const commit = (sha: string) => {
        if (!/^[a-f0-9]{40}$/.test(sha) || git("cat-file", "-t", sha) !== "commit") documentReject("DOCUMENT_SOURCE");
        return sha;
      };
      const develop = () => {
        storage("refs/heads/develop"); storage("packed-refs");
        if (probe(["symbolic-ref", "--quiet", "refs/heads/develop"], 1) !== null) documentReject("DOCUMENT_SOURCE");
        return commit(git("show-ref", "--verify", "--hash", "refs/heads/develop"));
      };
      const absent = () => {
        storage(ref); storage(`logs/${ref}`); storage("packed-refs");
        if (probe(["show-ref", "--exists", ref], 2) !== null) documentReject("DOCUMENT_CONFLICT");
        try { lstatSync(join(initial.repoRoot, ".git", "logs", ref)); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === "ENOENT") return;
          return documentReject("DOCUMENT_UNCERTAIN");
        }
        return documentReject("DOCUMENT_CONFLICT");
      };
      let intent: HandoffBranchIntent;
      let durable = original !== undefined;
      try {
        if (git("rev-parse", "--show-ref-format") !== "files" || git("rev-parse", "--show-object-format") !== "sha1") documentReject("DOCUMENT_SOURCE");
        absent();
        if (original) {
          if (original.record.change.kind !== "plan") return documentReject("DOCUMENT_CONFLICT");
          intent = original.record.change.intent;
          if (intent.action !== "create" || intent.requestId !== request.requestId || intent.branch !== request.branch
            || intent.ticket !== request.ticket || intent.expectedTicketVersion !== request.expectedTicketVersion
            || intent.callerIdentitySha256 !== initial.identitySha256 || !isDeepStrictEqual(intent.repository, repository)) documentReject("DOCUMENT_CONFLICT");
          commit(intent.base.sha);
        } else {
          const ticket = current(), sha = develop();
          if (creationDigest(ticket) !== request.expectedTicketVersion) documentReject("DOCUMENT_STALE");
          if (ticket.linkedBranches.length) documentReject("DOCUMENT_CONFLICT");
          intent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: request.requestId, callerIdentitySha256: initial.identitySha256,
            expectedTicketVersion: request.expectedTicketVersion, repository, ticket: request.ticket, branch: request.branch, action: "create",
            base: { ref: "refs/heads/develop", sha, observedDevelopSha: sha, observedAt: new Date().toISOString(), provenance: "local-develop-ref", remoteFreshness: "not-established" },
            plannedLinkSha256: creationDigest(null), lineage: null };
        }
      } catch (error) {
        if (error instanceof DocumentPackageError) throw error;
        return documentReject("DOCUMENT_UNCERTAIN");
      }
      const pinned = intent!;
      const result = store.applyHandoffWithIntent(request.ticket, request.expectedTicketVersion, { kind: "plan", intent: pinned }, "requirements/analyze", identity, {
        assertCurrent() { current(); },
        assertSnapshot(before) {
          current();
          if (creationDigest(before) !== pinned.expectedTicketVersion || before.project !== initial.repoKey) documentReject("DOCUMENT_CONFLICT");
          // New intent must pin the final pre-write observation. Once durable,
          // replay retains that exact pin/time even if develop has since moved.
          absent();
          if (!durable && develop() !== pinned.base.sha) documentReject("DOCUMENT_STALE");
        },
        afterPersist(stage) {
          if (stage === "intent") durable = true;
          const value: unknown = host.afterPersist?.(stage);
          if (value instanceof Promise) void value.catch(() => {});
          if (value !== undefined) documentReject("DOCUMENT_UNCERTAIN");
        },
      });
      const readback = store.inspectHandoffWithIntent(identity);
      if (!readback?.complete || readback.record.change.kind !== "plan" || !isDeepStrictEqual(readback.record.change.intent, pinned)
        || !isDeepStrictEqual(result.ticket.linkedBranches, readback.record.after.linkedBranches)) documentReject("DOCUMENT_UNCERTAIN");
      return { schemaVersion: "pa-handoff-plan-result/v1" as const, identity, intent: pinned, intentSha256: handoffBranchIntentSha(pinned),
        ticket: result.ticket, reused: result.reused, currentDevelopSha: develop(),
        approval: "not-issued", publication: "not-performed", branchRef: "not-created", queue: "not-performed", launchReady: false };
    })));
}
