import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withRepositoryRefAdmission } from "../deploy/repository-admission.js";
import { withRepositoryRefTicketExclusion } from "../deploy/ticket-concurrency.js";
import { getBranchPattern, loadRepoEntry } from "../repos.js";
import { creationDigest } from "../tickets/create-intent.js";
import { getDb } from "../registry/db.js";
import { TicketStore } from "../tickets/store.js";
import type { Ticket } from "../tickets/types.js";
import { SHA256, text } from "../workflows/contracts.js";
import { handoffBranchIntentSha, parseHandoffRequest, type HandoffBranchIntent } from "./handoff-contract.js";
import { intakeNativeHandoffTicket, type HandoffIntakeCaller, type HandoffIntakeHost } from "./handoff-intake.js";
import { DocumentPackageError, documentReject } from "./package-contract.js";
import { RegistryHandoffGitOwner } from "./handoff-git.js";
import type { RegistryHandoffReviewJournal } from "../registry/handoff-reviews.js";
import { assertLocalHandoffBranchTarget, observeLocalHandoffDevelop, withLocalHandoffRepository } from "./handoff-preflight.js";

export interface NativeHandoffPlanningCaller extends HandoffIntakeCaller {
  identitySha256: string;
  ticket: string;
}
export interface NativeHandoffPlanningHost extends HandoffIntakeHost {
  authenticate(): NativeHandoffPlanningCaller;
}
export function nativeHandoffTicketVersion(ticket: Ticket): string { return creationDigest(ticket); }
export function nativeHandoffPlanIdentity(caller: NativeHandoffPlanningCaller, requestId: string) {
  return { scope: creationDigest({ domain: "pa-handoff-plan/v1", deploymentId: caller.deploymentId, sessionId: caller.sessionId,
    identitySha256: caller.identitySha256, selectionSha256: caller.selectionSha256, repoKey: caller.repoKey, repoRoot: caller.repoRoot, ticket: caller.ticket }), requestId };
}

/** Same-session pre-subject observation. No intake, locks, DB opening, Git
 * observation or state repair. Native adapters own caller authentication. */
export function observeNativeHandoffPlan(host: NativeHandoffPlanningHost, rawRequest: string) {
  const request = parseHandoffRequest(rawRequest);
  if (request.action !== "plan") return documentReject("DOCUMENT_INPUT");
  const initial = structuredClone(host.authenticate());
  text(initial.identitySha256, SHA256);
  if (initial.ticket !== request.ticket) documentReject("DOCUMENT_AUTHORITY");
  const repo = loadRepoEntry(initial.repoKey);
  if (!repo || repo.path !== initial.repoRoot) documentReject("DOCUMENT_AUTHORITY");
  const identity = nativeHandoffPlanIdentity(initial, request.requestId);
  const observed = TicketStore.observeHandoffWithIntent(identity, request.ticket);
  if (observed.ticket.project !== initial.repoKey || !isDeepStrictEqual(initial, host.authenticate())) documentReject("DOCUMENT_AUTHORITY");
  const intent = observed.record?.change.kind === "plan" ? observed.record.change.intent : null;
  if (observed.record && (!intent || intent.ticket !== request.ticket || intent.branch !== request.branch
    || intent.expectedTicketVersion !== request.expectedTicketVersion || intent.requestId !== request.requestId
    || intent.callerIdentitySha256 !== initial.identitySha256 || intent.repository.key !== initial.repoKey
    || intent.repository.root !== initial.repoRoot)) documentReject("DOCUMENT_CONFLICT");
  return { schemaVersion: "pa-handoff-plan-status/v1" as const, identity,
    original: { ticket: request.ticket, requestId: request.requestId, expectedTicketVersion: request.expectedTicketVersion, branch: request.branch },
    disposition: observed.record ? observed.complete ? "complete" : "partial" : "absent", intent,
    ticketVersion: creationDigest(observed.ticket), ticketMatchesExpectedVersion: creationDigest(observed.ticket) === request.expectedTicketVersion,
    ticketStatus: observed.ticket.status, nextOwner: "original-plan-owner", observation: "point-in-time-not-effect-admission",
    authorityGranted: false, launchReady: false };
}

/** Native v2 successor only. Stable identity is derived from the exact stale
 * predecessor, never a replacement namespace supplied to hide uncertainty. */
export function refreshNativeHandoffTicket(store: TicketStore, journal: RegistryHandoffReviewJournal, subjectSha256: string,
  expectedRevision: number, expectedTicketVersion: string, assertCurrent: () => void, db: Database.Database) {
  const { subject, intent } = journal.subject(subjectSha256);
  if (subject.schemaVersion !== "pa-handoff-review/v2") return documentReject("DOCUMENT_AUTHORITY");
  const identity = { scope: subject.origin.planIdentity.scope, requestId: `refresh-${subjectSha256}` };
  return withLocalHandoffRepository(intent, admission => store.withWorkflowTransaction(() => journal.transaction(() => {
    assertCurrent();
    const history = journal.events(subjectSha256), disposition = history.at(-1);
    if (history.length !== expectedRevision || disposition?.kind !== "stale") documentReject("DOCUMENT_CONFLICT");
    const predecessor = store.inspectHandoffWithIntent(subject.origin.planIdentity);
    if (!predecessor?.complete || predecessor.record.change.kind !== "plan" || handoffBranchIntentSha(predecessor.record.change.intent) !== handoffBranchIntentSha(intent)) documentReject("DOCUMENT_AUTHORITY");
    const original = store.inspectHandoffWithIntent(identity), ticket = store.get(intent.ticket);
    if (!ticket || ticket.project !== intent.repository.key) documentReject("DOCUMENT_CONFLICT");
    if (original && (original.record.change.kind !== "plan" || original.record.change.predecessorPlanKey !== predecessor.record.key || original.record.expectedVersion !== expectedTicketVersion)) documentReject("DOCUMENT_CONFLICT");
    if (original?.complete && original.record.change.kind === "plan") {
      // Historical observation only: a successor may already have materialized
      // the link or develop may have moved again. Never redo CAS, repin or write
      // another audit to recover this completed preparation's lost response.
      const saved = original.record.change.intent;
      return { identity, intent: saved, intentSha256: handoffBranchIntentSha(saved), ticket, reused: true,
        predecessorSubjectSha256: subjectSha256, oldDevelopSha: intent.base.observedDevelopSha, newDevelopSha: saved.base.observedDevelopSha };
    }
    if (!isDeepStrictEqual(ticket.linkedBranches, predecessor.record.after.linkedBranches)) documentReject("DOCUMENT_CONFLICT");
    journal.assertSettled(subjectSha256);
    for (const event of history) if (event.kind === "requested" && event.request.operation === "capture") {
      if (journal.effect(subjectSha256, event.request.decisionId, "publish").started || journal.effect(subjectSha256, event.request.decisionId, "queue").started
        || journal.branchEffect(subjectSha256, event.request.decisionId).started) documentReject("DOCUMENT_UNCERTAIN");
    }
    const develop = observeLocalHandoffDevelop(intent);
    const next: HandoffBranchIntent = original?.record.change.kind === "plan" ? original.record.change.intent : {
      ...intent, requestId: identity.requestId, expectedTicketVersion,
      plannedLinkSha256: creationDigest(ticket.linkedBranches[0] ?? null),
      base: { ...intent.base, sha: intent.action === "create" ? develop : intent.base.sha, observedDevelopSha: develop, observedAt: new Date().toISOString() },
    };
    const verify = () => {
      assertCurrent();
      assertLocalHandoffBranchTarget(db, intent, admission);
    };
    verify();
    const result = store.applyHandoffWithIntent(intent.ticket, expectedTicketVersion, { kind: "plan", intent: next, predecessorPlanKey: predecessor.record.key }, "requirements/analyze", identity, {
      assertCurrent: verify,
      assertSnapshot(before, current) {
        verify();
        if (creationDigest(before) !== expectedTicketVersion || !isDeepStrictEqual(current.linkedBranches, predecessor.record.after.linkedBranches)) documentReject("DOCUMENT_CONFLICT");
        if (!original && observeLocalHandoffDevelop(intent) !== next.base.observedDevelopSha) documentReject("DOCUMENT_STALE");
      },
    });
    const saved = store.inspectHandoffWithIntent(identity);
    if (!saved?.complete || saved.record.change.kind !== "plan" || !isDeepStrictEqual(saved.record.change.intent, next)) documentReject("DOCUMENT_UNCERTAIN");
    return { identity, intent: next, intentSha256: handoffBranchIntentSha(next), ticket: result.ticket, reused: result.reused,
      predecessorSubjectSha256: subjectSha256, oldDevelopSha: intent.base.observedDevelopSha, newDevelopSha: next.base.observedDevelopSha };
  })));
}

/** Internal fresh/advanced composition, NOT selected tool grammar or authority.
 * Actual process/session and immutable selection authentication still belong to
 * the future native host. Existing intake admission rejects rogue/retained runs.
 * No public root/SHA/provenance/lineage/actor input and no ref/resource mutation.
 * Reuse requires the original native creation, complete journal and live Git
 * correlation. Legacy links are never adopted by name. */
export function planNativeHandoffTicket(store: TicketStore, host: NativeHandoffPlanningHost, rawRequest: string, db: Database.Database = getDb()) {
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
  const identity = nativeHandoffPlanIdentity(initial, request.requestId);
  return withRepositoryRefTicketExclusion(initial.repoKey, initial.repoRoot, exclusion =>
    withRepositoryRefAdmission(initial.repoRoot, exclusion, (physicalIdentitySha256, admission) => store.withWorkflowTransaction(() => {
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
        if (original) {
          if (original.record.change.kind !== "plan") return documentReject("DOCUMENT_CONFLICT");
          intent = original.record.change.intent;
          if (intent.requestId !== request.requestId || intent.branch !== request.branch
            || intent.ticket !== request.ticket || intent.expectedTicketVersion !== request.expectedTicketVersion
            || intent.callerIdentitySha256 !== initial.identitySha256 || !isDeepStrictEqual(intent.repository, repository)) documentReject("DOCUMENT_CONFLICT");
          commit(intent.base.sha);
        } else {
          const ticket = current(), sha = develop();
          if (creationDigest(ticket) !== request.expectedTicketVersion) documentReject("DOCUMENT_STALE");
          if (ticket.linkedBranches.length > 1) documentReject("DOCUMENT_CONFLICT");
          const link = ticket.linkedBranches[0];
          if (link && (link.repo !== initial.repoKey || link.branch !== request.branch || link.state !== "materialized"
            || !link.baseSha || !link.headSha || link.sha !== link.headSha)) documentReject("DOCUMENT_CONFLICT");
          const native = link ? new RegistryHandoffGitOwner(db).creationForPlan(repository, request.ticket, request.branch) : null;
          if (native && native.intent.base.sha !== link!.baseSha) documentReject("DOCUMENT_CONFLICT");
          // Head is owner-observed, not a request field. withRepository below
          // checks native marker, completed creation and exact current ancestry.
          const head = link ? commit(git("show-ref", "--verify", "--hash", ref)) : null;
          intent = { schemaVersion: "pa-handoff-branch-intent/v1", requestId: request.requestId, callerIdentitySha256: initial.identitySha256,
            expectedTicketVersion: request.expectedTicketVersion, repository, ticket: request.ticket, branch: request.branch, action: link ? "reuse" : "create",
            base: { ref: "refs/heads/develop", sha: native?.intent.base.sha ?? sha, observedDevelopSha: sha, observedAt: new Date().toISOString(),
              provenance: link ? "native-original-base" : "local-develop-ref", remoteFreshness: "not-established" },
            plannedLinkSha256: creationDigest(link ?? null), lineage: native ? { operationSha256: native.operationId, originalBaseSha: native.intent.base.sha, observedHeadSha: head! } : null };
        }
      } catch (error) {
        if (error instanceof DocumentPackageError) throw error;
        return documentReject("DOCUMENT_UNCERTAIN");
      }
      const pinned = intent!;
      const verifyRef = () => {
        if (pinned.action === "create") return absent();
        const link = (original?.record.before ?? current()).linkedBranches[0];
        if (!link || link.state !== "materialized" || link.baseSha !== pinned.base.sha || !link.headSha || link.sha !== link.headSha) documentReject("DOCUMENT_CONFLICT");
        // Reuse the opaque live repository admission, without reacquisition
        // under TicketStore or creating another capacity/lock owner.
        new RegistryHandoffGitOwner(db).withRepository(pinned, pinned.lineage!.operationSha256, port => {
          const observed = port.observe();
          if (observed.state !== "present" || observed.owner.kind !== "lineage" || observed.owner.sha256 !== pinned.lineage!.operationSha256
            || !port.isAncestor(link.headSha!, observed.headSha)) documentReject("DOCUMENT_UNCERTAIN");
        }, undefined, admission);
      };
      verifyRef();
      const result = store.applyHandoffWithIntent(request.ticket, request.expectedTicketVersion, { kind: "plan", intent: pinned }, "requirements/analyze", identity, {
        assertCurrent() { current(); },
        assertSnapshot(before) {
          current();
          if (creationDigest(before) !== pinned.expectedTicketVersion || before.project !== initial.repoKey) documentReject("DOCUMENT_CONFLICT");
          // New intent must pin the final pre-write observation. Once durable,
          // replay retains that exact pin/time even if develop has since moved.
          verifyRef();
          if (!durable && develop() !== pinned.base.observedDevelopSha) documentReject("DOCUMENT_STALE");
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
      verifyRef();
      return { schemaVersion: "pa-handoff-plan-result/v1" as const, identity, intent: pinned, intentSha256: handoffBranchIntentSha(pinned),
        ticket: result.ticket, reused: result.reused, currentDevelopSha: develop(),
        approval: "not-issued", publication: "not-performed", branchRef: pinned.action === "create" ? "not-created" : "existing-not-completed-by-this-operation", queue: "not-performed", launchReady: false };
    })));
}
