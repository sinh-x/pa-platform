import { spawn } from "node:child_process";
import { statusFail, statusKey, statusVersion, statusCandidate, statusIntents, readStatusIntent, publishStatusIntent, statusAudit, statusAuditComplete, TICKET_STATUSES, type TicketStatusHooks } from "./status-intent.js";
import { TicketPlanningIntentError, ticketPlanningVersion, validatePlanningPatch, validPlanningDigest, assertPlanningScope, planningKey, readPlanningIntent, planningIntents, publishPlanningIntent, planningAudit, planningAuditComplete, type TicketPlanningPatch, type TicketPlanningHooks } from "./planning-intent.js";
import { AdvisoryFiles } from "../operations/files.js";
import { parseReviewEvidenceJson } from "../validation/review-contract.js";
import { TicketCreateIntentError, creationDigest, creationKey, creationReservations, publishCreationIntent, readCreationIntent, type TicketCreateIntentIdentity, type TicketCreateIntentHooks } from "./create-intent.js";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getTicketsDir } from "../paths.js";
import { resolveProject } from "../repos.js";
import { nowUtc, parseTimestamp } from "../time.js";
import { resolveLinkedBranch, resolveLinkedCommit } from "./git-validation.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./types.js";
import { isCanonicalTicketId, matchAssignee } from "./validate.js";
import { queryDeploymentStatus } from "../registry/index.js";
import type { AddDocRefInput, AddLinkedBranchInput, AddLinkedCommitInput, AuditEntry, Comment, CounterStore, CreateTicketInput, DocRef, LinkedBranch, LinkedCommit, SubTicket, Ticket, TicketListFilters, TicketStatus, UpdateTicketInput } from "./types.js";

const VALID_STATUSES = new Set<TicketStatus>([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);
const TICKET_TRANSACTION_MUTEX_FILE = ".ticket-store-transaction.lock";
const TICKET_TRANSACTION_MUTEX_TIMEOUT_MS = 5_000;
const TICKET_TRANSACTION_MUTEX_POLL_MS = 25;

export interface TicketMutationContext {
  team?: string;
  mode?: string;
  privileged?: boolean;
}

export interface TicketMutationPrincipal {
  deploymentId?: string;
  operator?: boolean;
}

/** Native materialization/metadata-refresh precondition, not a caller SHA override. */
export interface TicketLinkedHeadExpectation {
  readonly repo: string;
  readonly branch: string;
  readonly baseSha?: string;
  readonly expectedHeadSha: string;
  readonly headSha: string;
}

export class TicketStore {
  private readonly dir: string;
  private readonly context: TicketMutationContext;
  private transactionDepth = 0;

  constructor(dir = getTicketsDir(), context: TicketMutationContext = {}) {
    this.dir = dir;
    this.context = context;
    mkdirSync(this.dir, { recursive: true });
  }

  private withTransaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    return withTicketTransactionMutex(this.dir, () => {
      this.transactionDepth += 1;
      try {
        return operation();
      } finally {
        this.transactionDepth -= 1;
      }
    });
  }

  /** Trusted service adapter seam. Serializes paired publication/queue with ALL ordinary ticket writers.
   * Holding this mutex conveys no authority; the adapter must reauthenticate inside it. */
  withWorkflowTransaction<T>(operation: () => T): T {
    return this.withTransaction(operation);
  }

  create(input: CreateTicketInput, actor = "pa-core"): Ticket {
    const { key, prefix } = resolveProject(input.project);
    return this.withTransaction(() => {
      const id = this.allocateId(prefix);
      const now = nowUtc();
      const ticket = this.normalizeTicket({
        ...input,
        id,
        project: key,
        createdAt: now,
        updatedAt: now,
        resolvedAt: input.resolvedAt ?? null,
        subTickets: [],
        nextSubTicketCounter: 0,
        linkedBranches: input.linkedBranches ?? [],
        linkedCommits: input.linkedCommits ?? [],
      });
      this.writeTicket(ticket);
      this.appendAudit(id, "created", actor, { status: ["", ticket.status], assignee: ["", ticket.assignee] });
      return ticket;
    });
  }

  /** New finite creation primitive. Legacy create/document-intake behavior is
   * retained; adapters must separately authenticate their selected writer profile.
   * The SAME ticket mutex owns reservation, ticket and audit reconciliation.
   * An immutable intent reserves an ID before counter/ticket/audit effects. */
  createWithIntent(input: CreateTicketInput, actor: string, identity: TicketCreateIntentIdentity, hooks: TicketCreateIntentHooks): { ticket: Ticket; reused: boolean } {
    const key = creationKey(identity);
    if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) throw new TicketCreateIntentError("TICKET_CREATE_INPUT");
    const { key: project, prefix } = resolveProject(input.project);
    const normalizedInput = { ...input, project };
    if (hooks.requestBinding !== undefined && (typeof hooks.requestBinding !== "string" || hooks.requestBinding.length !== 64 || !/^[a-f0-9]{64}$/.test(hooks.requestBinding))) throw new TicketCreateIntentError("TICKET_CREATE_INPUT");
    // Keep retained unbound-intent digests unchanged. The optional new adapter
    // binding detects changed raw requests even when sanitization loses bytes.
    const payloadSha256 = creationDigest({ input: normalizedInput, actor, ...(hooks.requestBinding === undefined ? {} : { requestBinding: hooks.requestBinding }) });
    const assertCurrent = (): void => {
      const result: unknown = hooks.assertCurrent();
      if (result instanceof Promise) void result.catch(() => {});
      if (result !== undefined) throw new TicketCreateIntentError("TICKET_CREATE_INPUT");
    };
    const observed = (stage: "intent" | "ticket" | "audit"): void => {
      const result: unknown = hooks.afterPersist?.(stage);
      if (result instanceof Promise) void result.catch(() => {});
      if (result !== undefined) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
    };
    return this.withTransaction(() => {
      assertCurrent();
      let record = readCreationIntent(this.dir, key);
      const reused = record !== undefined;
      if (record && (record.payloadSha256 !== payloadSha256 || record.actor !== actor)) throw new TicketCreateIntentError("TICKET_CREATE_CONFLICT");
      if (!record) {
        const id = this.nextAvailableId(prefix), now = nowUtc();
        const ticket = this.normalizeTicket({ ...normalizedInput, id, createdAt: now, updatedAt: now, resolvedAt: input.resolvedAt ?? null,
          subTickets: [], nextSubTicketCounter: 0, linkedBranches: input.linkedBranches ?? [], linkedCommits: input.linkedCommits ?? [] });
        record = { schemaVersion: "pa-ticket-create-intent/v1", key, ...identity, payloadSha256, ticketSha256: creationDigest(ticket), actor, ticket };
        assertCurrent();
        publishCreationIntent(this.dir, record);
        observed("intent");
      }
      const planned = record.ticket;
      // Never silently normalize malformed persisted candidate bytes.
      if (!isDeepStrictEqual(this.normalizeTicket(planned as unknown as Record<string, unknown>), planned) || planned.project !== project) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
      const expectedAudit: AuditEntry = { ticket_id: planned.id, action: "created", actor, timestamp: planned.createdAt,
        changes: { status: ["", planned.status], assignee: ["", planned.assignee] } };
      let audits: AuditEntry[], current: Ticket | undefined;
      try { audits = this.readCreationAudits().entries.filter(row => row.ticket_id === planned.id && row.action === "created"); current = this.get(planned.id); }
      catch { throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
      if (audits.length > 1 || (audits.length === 1 && (creationDigest(audits[0]) !== creationDigest(expectedAudit) || !current || current.id !== planned.id || current.project !== project))) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
      if (audits.length === 0) {
        if (current && !isDeepStrictEqual(current, planned)) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
        if (!current) {
          assertCurrent();
          // The durable reservation is already visible to all ordinary ID allocators.
          this.advanceCounter(prefix, planned.id);
          // A symlink/foreign inode or corrupt existing file is not an absent ticket.
          const files = new AdvisoryFiles(this.dir);
          try { files.file(`${planned.id}.json`); throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
          files.file(`${planned.id}.json`, JSON.stringify(planned, null, 2));
          observed("ticket");
        }
        assertCurrent();
        const readback = this.get(planned.id);
        if (!readback || !isDeepStrictEqual(readback, planned)) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
        const previous = this.readCreationAudits().raw;
        new AdvisoryFiles(this.dir).file("audit.jsonl", `${previous}${JSON.stringify(expectedAudit)}\n`);
        observed("audit");
      }
      assertCurrent();
      const persisted = this.get(planned.id);
      const finalAudits = this.readCreationAudits().entries.filter(row => row.ticket_id === planned.id && row.action === "created");
      if (!persisted || persisted.id !== planned.id || persisted.project !== project || finalAudits.length !== 1 || creationDigest(finalAudits[0]) !== creationDigest(expectedAudit)) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
      return { ticket: persisted, reused };
    });
  }

  /** Finite scalar planning data primitive, NOT native role/lifecycle authority.
   * A future admitted adapter must authenticate ownership on every locked callback.
   * Immutable intent precedes effects; unknown partial state is never rolled back. */
  patchPlanningWithIntent(id: string, expectedVersion: string, rawPatch: TicketPlanningPatch, actor: string, identity: TicketCreateIntentIdentity, hooks: TicketPlanningHooks): { ticket: Ticket; appliedVersion: string; reused: boolean } {
    const boundIdentity = Object.freeze({ ...identity }), key = planningKey(boundIdentity), patch = validatePlanningPatch(rawPatch);
    if (!isCanonicalTicketId(id) || !validPlanningDigest(expectedVersion) || typeof actor !== "string" || !actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)
      || (hooks.requestBinding !== undefined && !validPlanningDigest(hooks.requestBinding))) throw new TicketPlanningIntentError("TICKET_PLAN_INPUT");
    const payloadSha256 = creationDigest({ id, expectedVersion, patch, actor, ...(hooks.requestBinding === undefined ? {} : { requestBinding: hooks.requestBinding }) });
    const assertCurrent = () => {
      const result: unknown = hooks.assertCurrent();
      if (result instanceof Promise) void result.catch(() => {});
      if (result !== undefined) throw new TicketPlanningIntentError("TICKET_PLAN_INPUT");
    };
    const observed = (stage: "intent" | "ticket" | "audit") => {
      const result: unknown = hooks.afterPersist?.(stage);
      if (result instanceof Promise) void result.catch(() => {});
      if (result !== undefined) throw new TicketPlanningIntentError("TICKET_PLAN_UNCERTAIN");
    };
    const readAudits = () => {
      try { return this.readCreationAudits(); } catch { throw new TicketPlanningIntentError("TICKET_PLAN_UNCERTAIN"); }
    };
    return this.withTransaction(() => {
      assertCurrent();
      let record = readPlanningIntent(this.dir, key);
      const reused = record !== undefined;
      if (record && (record.payloadSha256 !== payloadSha256 || record.before.id !== id || record.actor !== actor
        || record.expectedVersion !== expectedVersion || !isDeepStrictEqual(record.patch, patch))) throw new TicketPlanningIntentError("TICKET_PLAN_CONFLICT");
      const assertSnapshot = (ticket: Ticket) => {
        // A copy prevents a trusted validation callback from accidentally editing
        // the historical record that the owner will subsequently publish/replay.
        const result: unknown = hooks.assertSnapshot?.(JSON.parse(JSON.stringify(ticket)) as Ticket);
        if (result instanceof Promise) void result.catch(() => {});
        if (result !== undefined) throw new TicketPlanningIntentError("TICKET_PLAN_INPUT");
      };
      if (record) assertSnapshot(record.before);
      // A missing final audit is a pending owner effect, including when the
      // candidate ticket is already visible. Fresh IDs may not bypass it.
      const audits = readAudits().entries;
      for (const previous of planningIntents(this.dir)) {
        if (previous.before.id === id && previous.key !== key && !planningAuditComplete(previous, audits)) throw new TicketPlanningIntentError("TICKET_PLAN_UNCERTAIN");
      }
      if (!record) {
        const before = this.get(id);
        assertPlanningScope(before, id);
        if (ticketPlanningVersion(before) !== expectedVersion) throw new TicketPlanningIntentError("TICKET_PLAN_STALE");
        assertSnapshot(before);
        if (Object.entries(patch).every(([field, value]) => before[field as keyof TicketPlanningPatch] === value)) throw new TicketPlanningIntentError("TICKET_PLAN_INPUT");
        const after = { ...before, ...patch, updatedAt: nowUtc() };
        record = { schemaVersion: "pa-ticket-planning-intent/v1", key, ...boundIdentity, payloadSha256, actor, expectedVersion,
          appliedVersion: ticketPlanningVersion(after), patch, before, after };
        assertCurrent();
        if (!isDeepStrictEqual(this.get(id), before)) throw new TicketPlanningIntentError("TICKET_PLAN_STALE");
        validatePlanningPatch(patch); // Recheck current sensitive-input policy under the owner lock.
        publishPlanningIntent(this.dir, record);
        observed("intent");
      }
      if (!isDeepStrictEqual(this.normalizeTicket(record.before as unknown as Record<string, unknown>), record.before)
        || !isDeepStrictEqual(this.normalizeTicket(record.after as unknown as Record<string, unknown>), record.after)) throw new TicketPlanningIntentError("TICKET_PLAN_UNCERTAIN");
      if (!planningAuditComplete(record, readAudits().entries)) {
        const current = this.get(id);
        if (!isDeepStrictEqual(current, record.before) && !isDeepStrictEqual(current, record.after)) throw new TicketPlanningIntentError("TICKET_PLAN_UNCERTAIN");
        if (isDeepStrictEqual(current, record.before)) {
          assertCurrent();
          if (!isDeepStrictEqual(this.get(id), record.before)) throw new TicketPlanningIntentError("TICKET_PLAN_UNCERTAIN");
          validatePlanningPatch(patch);
          new AdvisoryFiles(this.dir).file(`${id}.json`, JSON.stringify(record.after, null, 2));
          observed("ticket");
        }
        assertCurrent();
        if (!isDeepStrictEqual(this.get(id), record.after)) throw new TicketPlanningIntentError("TICKET_PLAN_UNCERTAIN");
        const previous = readAudits().raw;
        new AdvisoryFiles(this.dir).file("audit.jsonl", `${previous}${JSON.stringify(planningAudit(record))}\n`);
        observed("audit");
      }
      assertCurrent();
      const persisted = this.get(id);
      if (!persisted || persisted.id !== id || persisted.project !== record.after.project || !planningAuditComplete(record, readAudits().entries)) throw new TicketPlanningIntentError("TICKET_PLAN_UNCERTAIN");
      return { ticket: persisted, appliedVersion: record.appliedVersion, reused };
    });
  }

  /** Status-only finite owner. Durable intent precedes ticket/audit writes under
   * the same mutex as legacy writers and protected publication. No approval effect. */
  setStatusWithIntent(id: string, expectedVersion: string, status: TicketStatus, actor: string, identity: TicketCreateIntentIdentity, hooks: TicketStatusHooks): { ticket: Ticket; appliedVersion: string; reused: boolean } {
    const key = statusKey(identity);
    if (!isCanonicalTicketId(id) || !/^[a-f0-9]{64}$/.test(expectedVersion) || !TICKET_STATUSES.includes(status)
      || !actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) return statusFail("TICKET_STATUS_INPUT");
    const payloadSha256 = creationDigest({ id, expectedVersion, status, actor });
    const check = () => {
      const checked: unknown = hooks.assertCurrent();
      if (checked instanceof Promise) void checked.catch(() => {});
      if (checked !== undefined) statusFail("TICKET_STATUS_SESSION");
      assertLifecycleOwnership(status, this.context);
    };
    const observed = (stage: "intent" | "ticket" | "audit") => {
      const result: unknown = hooks.afterPersist?.(stage);
      if (result instanceof Promise) void result.catch(() => {});
      if (result !== undefined) statusFail("TICKET_STATUS_UNCERTAIN");
    };
    return this.withTransaction(() => {
      check();
      let record = readStatusIntent(this.dir, key);
      const reused = record !== undefined;
      if (record && (record.payloadSha256 !== payloadSha256 || record.before.id !== id || record.expectedVersion !== expectedVersion || record.actor !== actor || record.status !== status)) statusFail("TICKET_STATUS_CONFLICT");
      for (const pending of statusIntents(this.dir)) if (pending.before.id === id && pending.key !== key && !statusAuditComplete(pending, this.readCreationAudits().entries)) statusFail("TICKET_STATUS_UNCERTAIN");
      if (!record) {
        const before = this.get(id);
        if (!before) return statusFail("TICKET_STATUS_INPUT");
        if (statusVersion(before) !== expectedVersion) return statusFail("TICKET_STATUS_STALE");
        if (status === "done" && before.subTickets.some(sub => sub.status !== "done")) return statusFail("TICKET_STATUS_INPUT");
        const after = before.status === status ? before : statusCandidate(before, status, nowUtc());
        record = { schemaVersion: "pa-ticket-status-intent/v1", key, scope: identity.scope, requestId: identity.requestId, payloadSha256, actor, expectedVersion, status, before, after };
        check();
        if (!isDeepStrictEqual(this.get(id), before)) statusFail("TICKET_STATUS_STALE");
        publishStatusIntent(this.dir, record); observed("intent");
      }
      if (!isDeepStrictEqual(this.normalizeTicket(record.before as unknown as Record<string, unknown>), record.before)
        || !isDeepStrictEqual(this.normalizeTicket(record.after as unknown as Record<string, unknown>), record.after)) statusFail("TICKET_STATUS_UNCERTAIN");
      if (!statusAuditComplete(record, this.readCreationAudits().entries)) {
        const current = this.get(id);
        if (!isDeepStrictEqual(current, record.before) && !isDeepStrictEqual(current, record.after)) statusFail("TICKET_STATUS_UNCERTAIN");
        if (isDeepStrictEqual(current, record.before)) {
          check();
          if (!isDeepStrictEqual(this.get(id), record.before)) statusFail("TICKET_STATUS_UNCERTAIN");
          new AdvisoryFiles(this.dir).file(`${id}.json`, JSON.stringify(record.after, null, 2)); observed("ticket");
        }
        check();
        if (!isDeepStrictEqual(this.get(id), record.after)) statusFail("TICKET_STATUS_UNCERTAIN");
        const previous = this.readCreationAudits().raw;
        new AdvisoryFiles(this.dir).file("audit.jsonl", `${previous}${JSON.stringify(statusAudit(record))}\n`); observed("audit");
      }
      check();
      const current = this.get(id);
      if (!current || current.id !== id || current.project !== record.after.project || !statusAuditComplete(record, this.readCreationAudits().entries)) return statusFail("TICKET_STATUS_UNCERTAIN");
      return { ticket: current, appliedVersion: statusVersion(record.after), reused };
    });
  }

  get(id: string): Ticket | undefined {
    return this.readTicket(id, new Set<string>());
  }

  update(id: string, input: UpdateTicketInput, actor = "pa-core", context = this.context): Ticket {
    return this.updateWithLinkedHeadExpectation(id, input, actor, context);
  }

  /** Existing ticket writer/audit owner, with native Git resolution compared to
   * the exact intended predecessor and target BEFORE publishing any bytes. */
  refreshLinkedBranchHead(id: string, expected: TicketLinkedHeadExpectation, actor: string): Ticket {
    return this.updateWithLinkedHeadExpectation(id, { add_linked_branch: { repo: expected.repo, branch: expected.branch, linkedBy: actor } }, actor, this.context, expected);
  }

  private updateWithLinkedHeadExpectation(id: string, input: UpdateTicketInput, actor: string, context: TicketMutationContext, expected?: TicketLinkedHeadExpectation): Ticket {
    assertLifecycleOwnership(input.status, context);
    if (Object.prototype.hasOwnProperty.call(input, "linkedBranches")) {
      throw new Error("Direct linkedBranches replacement is not allowed. Correction: use add_linked_branch so repository and Git evidence are authenticated.");
    }
    return this.withTransaction(() => {
      const current = this.get(id);
      if (!current) throw new Error(`Ticket not found: ${id}`);
      if (input.status !== undefined && !VALID_STATUSES.has(input.status)) throw new Error(`Invalid status: ${input.status}`);
      if (input.status === "done" && current.subTickets.some((sub) => sub.status !== "done")) {
        throw new Error(`Cannot mark ${id} as done while sub-tickets are open`);
      }

      const {
        add_doc_ref: addDocRef,
        remove_doc_ref: removeDocRef,
        add_linked_branch: addLinkedBranch,
        remove_linked_branch: removeLinkedBranch,
        add_linked_commit: addLinkedCommit,
        remove_linked_commit: removeLinkedCommit,
        ...rest
      } = input;
      const linkedAuditIntents: AuditIntent[] = [];
      const collectLinkedAudit: AuditAppender = (ticketId, action, auditActor, changes) => {
        linkedAuditIntents.push({ ticketId, action, actor: auditActor, changes });
      };
      let next: Ticket = { ...current, ...rest, updatedAt: nowUtc() };
      if (input.status && TERMINAL_STATUSES.includes(input.status)) next.resolvedAt = next.resolvedAt ?? next.updatedAt;
      if (input.status && !TERMINAL_STATUSES.includes(input.status)) next.resolvedAt = null;
      if (addDocRef) next = { ...next, doc_refs: this.addDocRef(next.doc_refs, addDocRef, actor, next.updatedAt) };
      if (removeDocRef) next = { ...next, doc_refs: next.doc_refs.filter((ref) => ref.path !== removeDocRef) };
      next = applyLinkedBranchMutation(id, next, addLinkedBranch, removeLinkedBranch, actor, collectLinkedAudit, expected);
      next = applyLinkedCommitMutation(id, next, addLinkedCommit, removeLinkedCommit, actor, collectLinkedAudit);
      next = this.normalizeTicket(next as unknown as Record<string, unknown>);

      const changes = diffTicket(current, next);
      const auditSnapshot = this.readAuditSnapshot();
      let persisted: Ticket;
      try {
        this.writeTicket(next);
        const readback = this.get(id);
        if (!readback || !ticketsEqual(readback, next)) {
          throw new Error("the disk-backed ticket did not equal the validated candidate");
        }
        persisted = readback;
        this.appendAudits([
          ...linkedAuditIntents,
          { ticketId: id, action: "updated", actor, changes },
        ]);
      } catch (error) {
        let restored = false;
        try {
          this.writeTicket(current);
          this.restoreAuditSnapshot(auditSnapshot);
          const restorationReadback = this.get(id);
          restored = restorationReadback !== undefined
            && ticketsEqual(restorationReadback, current)
            && this.readAuditSnapshot() === auditSnapshot;
        } catch {
          restored = false;
        }
        throw new Error(linkedBranchPostconditionDiagnostic(id, removeLinkedBranch, error, restored));
      }
      return persisted;
    });
  }

  comment(id: string, author: string, content: string): Comment {
    return this.withTransaction(() => {
      const ticket = this.get(id);
      if (!ticket) throw new Error(`Ticket not found: ${id}`);
      const now = nowUtc();
      const comment: Comment = { id: `c-${now.replace(/[^0-9]/g, "")}`, author, content, timestamp: now };
      this.writeTicket({ ...ticket, comments: [...ticket.comments, comment], updatedAt: now });
      this.appendAudit(id, "commented", author, { comments: [ticket.comments.length, ticket.comments.length + 1] });
      return comment;
    });
  }

  editComment(id: string, commentId: string, content: string, actor = "pa-core"): { ticket: Ticket; comment: Comment } {
    return this.withTransaction(() => {
      const ticket = this.get(id);
      if (!ticket) throw new Error(`Ticket not found: ${id}`);
      const index = ticket.comments.findIndex((comment) => comment.id === commentId);
      if (index < 0) throw new Error(`Comment not found: ${commentId}`);
      const now = nowUtc();
      const comment: Comment = { ...ticket.comments[index]!, content, editedAt: now };
      const comments = ticket.comments.map((existing, existingIndex) => existingIndex === index ? comment : existing);
      const next = { ...ticket, comments, updatedAt: now };
      this.writeTicket(next);
      this.appendAudit(id, "updated", actor, { comment: [ticket.comments[index], comment] });
      return { ticket: next, comment };
    });
  }

  deleteComment(id: string, commentId: string, actor = "pa-core"): Ticket {
    return this.withTransaction(() => {
      const ticket = this.get(id);
      if (!ticket) throw new Error(`Ticket not found: ${id}`);
      const comments = ticket.comments.filter((comment) => comment.id !== commentId);
      if (comments.length === ticket.comments.length) throw new Error(`Comment not found: ${commentId}`);
      const next = { ...ticket, comments, updatedAt: nowUtc() };
      this.writeTicket(next);
      this.appendAudit(id, "updated", actor, { comments: [ticket.comments.length, comments.length] });
      return next;
    });
  }

  attach(id: string, path: string, actor = "pa-core"): Ticket {
    return this.update(id, { add_doc_ref: { type: "attachment", path } }, actor);
  }

  move(id: string, project: string, actor = "pa-core"): Ticket {
    const { key, prefix } = resolveProject(project);
    return this.withTransaction(() => {
      const current = this.get(id);
      if (!current) throw new Error(`Ticket not found: ${id}`);
      const newId = this.allocateId(prefix);
      const now = nowUtc();
      const moved = this.normalizeTicket({ ...current, id: newId, project: key, updatedAt: now });
      this.writeTicket(moved);
      writeFileSync(this.ticketPath(id), JSON.stringify({ _alias: true, movedTo: newId, movedAt: now, movedBy: actor }, null, 2));
      this.appendAudit(id, "updated", actor, { movedTo: [id, newId] });
      this.appendAudit(newId, "created", actor, { movedFrom: [id, newId] });
      return moved;
    });
  }

  delete(id: string, actor = "pa-core", hard = false, context = this.context): void {
    assertLifecycleOwnership("cancelled", context);
    this.withTransaction(() => {
      const ticket = this.get(id);
      if (!ticket) throw new Error(`Ticket not found: ${id}`);
      if (hard) {
        unlinkSync(this.ticketPath(id));
        this.appendAudit(id, "deleted", actor, { hard: [false, true] });
        return;
      }
      this.update(id, { status: "cancelled" }, actor, context);
      this.appendAudit(id, "deleted", actor, { status: [ticket.status, "cancelled"] });
    });
  }

  archive(id: string, actor = "pa-core"): Ticket {
    return this.withTransaction(() => {
      const current = this.get(id);
      if (!current) throw new Error(`Ticket not found: ${id}`);
      if (!TERMINAL_STATUSES.includes(current.status)) {
        throw new Error(`Cannot archive ${id}: status is '${current.status}'. Only terminal-status tickets (${TERMINAL_STATUSES.join(", ")}) can be archived.`);
      }
      if (current.tags.includes("archived")) return current;
      const now = nowUtc();
      const next: Ticket = { ...current, tags: [...current.tags, "archived"], updatedAt: now };
      this.writeTicket(next);
      this.appendAudit(id, "archived", actor, { tags: [current.tags, next.tags] });
      return next;
    });
  }

  unarchive(id: string, actor = "pa-core"): Ticket {
    return this.withTransaction(() => {
      const current = this.get(id);
      if (!current) throw new Error(`Ticket not found: ${id}`);
      if (!current.tags.includes("archived")) return current;
      const now = nowUtc();
      const next: Ticket = { ...current, tags: current.tags.filter((tag) => tag !== "archived"), updatedAt: now };
      this.writeTicket(next);
      this.appendAudit(id, "unarchived", actor, { tags: [current.tags, next.tags] });
      return next;
    });
  }

  addSubTicket(parentId: string, input: Pick<SubTicket, "title" | "summary" | "assignee" | "priority" | "estimate">, actor = "pa-core"): { ticket: Ticket; subTicket: SubTicket } {
    return this.withTransaction(() => {
      const ticket = this.get(parentId);
      if (!ticket) throw new Error(`Ticket not found: ${parentId}`);
      const now = nowUtc();
      const nextCounter = ticket.nextSubTicketCounter + 1;
      const subTicket: SubTicket = { id: `${ticket.id}-ST-${nextCounter}`, title: input.title, summary: input.summary, assignee: input.assignee, priority: input.priority, estimate: input.estimate, status: "open", createdAt: now, updatedAt: now };
      const next = { ...ticket, subTickets: [...ticket.subTickets, subTicket], nextSubTicketCounter: nextCounter, updatedAt: now };
      this.writeTicket(next);
      this.appendAudit(parentId, "updated", actor, { subTickets: [ticket.subTickets.length, next.subTickets.length] });
      return { ticket: next, subTicket };
    });
  }

  updateSubTicket(parentId: string, subTicketId: string, input: Partial<Pick<SubTicket, "title" | "summary" | "status" | "assignee" | "priority" | "estimate">>, actor = "pa-core"): { ticket: Ticket; subTicket: SubTicket } {
    return this.withTransaction(() => {
      const ticket = this.get(parentId);
      if (!ticket) throw new Error(`Ticket not found: ${parentId}`);
      const index = ticket.subTickets.findIndex((sub) => sub.id === subTicketId);
      if (index < 0) throw new Error(`Sub-ticket not found: ${subTicketId}`);
      const now = nowUtc();
      const subTicket = { ...ticket.subTickets[index]!, ...input, updatedAt: now };
      const subTickets = ticket.subTickets.map((sub, i) => (i === index ? subTicket : sub));
      const next = { ...ticket, subTickets, updatedAt: now };
      this.writeTicket(next);
      this.appendAudit(parentId, "updated", actor, { subTicket: [ticket.subTickets[index], subTicket] });
      return { ticket: next, subTicket };
    });
  }

  listSubTickets(parentId: string): SubTicket[] {
    const ticket = this.get(parentId);
    if (!ticket) throw new Error(`Ticket not found: ${parentId}`);
    return ticket.subTickets;
  }

  list(filters: TicketListFilters = {}): Ticket[] {
    return readdirSync(this.dir)
      .filter((file) => file.endsWith(".json") && file !== "counter.json")
      .map((file) => this.get(file.slice(0, -5)))
      .filter((ticket): ticket is Ticket => !!ticket)
      .filter((ticket) => matchesFilters(ticket, filters))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getProjectCounts(): Array<{ key: string; count: number }> {
    const tickets = this.list({ excludeTags: ["archived", "backlog"] });
    const counts = new Map<string, number>();
    for (const ticket of tickets) {
      if (TERMINAL_STATUSES.includes(ticket.status)) continue;
      counts.set(ticket.project, (counts.get(ticket.project) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 0)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  readAudit(): AuditEntry[] {
    const path = resolve(this.dir, "audit.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditEntry);
  }

  private readCreationAudits(): { raw: string; entries: AuditEntry[] } {
    let bytes: Buffer;
    try { bytes = new AdvisoryFiles(this.dir).file("audit.jsonl") as Buffer; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: "", entries: [] }; throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
    let raw: string;
    try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
    // A torn final row is unknown; never concatenate a new event onto it.
    if (raw && !raw.endsWith("\n")) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
    try {
      const entries = raw.split("\n").filter(Boolean).map(line => parseReviewEvidenceJson(Buffer.from(line), "ticket-audit") as AuditEntry);
      if (entries.some(entry => !entry || typeof entry !== "object" || typeof entry.ticket_id !== "string" || typeof entry.action !== "string" || typeof entry.actor !== "string" || !entry.changes)) throw new Error();
      return { raw, entries };
    } catch { throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
  }

  private ticketPath(id: string): string {
    if (!isCanonicalTicketId(id)) throw new Error("Ticket ID must be canonical");
    const directory = resolve(this.dir);
    const path = resolve(directory, `${id}.json`);
    if (dirname(path) !== directory) throw new Error("Ticket path must remain inside the ticket store");
    return path;
  }

  private readTicket(id: string, visited: Set<string>): Ticket | undefined {
    if (!isCanonicalTicketId(id) || visited.has(id)) return undefined;
    visited.add(id);
    const path = this.ticketPath(id);
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined;
      throw error;
    }
    let contents: string;
    try {
      if (!fstatSync(descriptor).isFile()) return undefined;
      contents = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
    const raw = JSON.parse(contents) as Record<string, unknown>;
    if (raw["_alias"] === true) {
      return isCanonicalTicketId(raw["movedTo"]) ? this.readTicket(raw["movedTo"], visited) : undefined;
    }
    if (raw["id"] !== id) return undefined;
    return this.normalizeTicket(raw);
  }

  private readCreationCounters(): CounterStore {
    let bytes: Buffer;
    try { bytes = new AdvisoryFiles(this.dir).file("counter.json") as Buffer; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
    try {
      const counters = parseReviewEvidenceJson(bytes, "ticket-counter") as CounterStore;
      if (!counters || typeof counters !== "object" || Array.isArray(counters)
        || Object.entries(counters).some(([prefix, value]) => !/^[A-Z][A-Z0-9]*$/.test(prefix) || !Number.isSafeInteger(value) || value < 0)) throw new Error();
      return { ...counters };
    } catch { throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN"); }
  }

  private nextAvailableId(prefix: string): string {
    const counters = this.readCreationCounters();
    const reservations = creationReservations(this.dir);
    let next = (counters[prefix] ?? 0) + 1;
    while (reservations.has(`${prefix}-${String(next).padStart(3, "0")}`)) next++;
    if (!Number.isSafeInteger(next) || next < 1) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
    return `${prefix}-${String(next).padStart(3, "0")}`;
  }

  private advanceCounter(prefix: string, id: string): void {
    const counters = this.readCreationCounters();
    const next = Number(id.slice(prefix.length + 1));
    if (!Number.isSafeInteger(next) || next < 1) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
    counters[prefix] = Math.max(counters[prefix] ?? 0, next);
    new AdvisoryFiles(this.dir).file("counter.json", JSON.stringify(counters, null, 2));
  }

  private allocateId(prefix: string): string {
    const id = this.nextAvailableId(prefix);
    this.advanceCounter(prefix, id);
    return id;
  }

  private normalizeTicket(raw: Record<string, unknown>): Ticket {
    return {
      id: String(raw["id"] ?? ""),
      project: String(raw["project"] ?? "unknown"),
      title: String(raw["title"] ?? "(untitled)"),
      summary: String(raw["summary"] ?? ""),
      description: String(raw["description"] ?? ""),
      status: (raw["status"] as Ticket["status"] | undefined) ?? "idea",
      priority: (raw["priority"] as Ticket["priority"] | undefined) ?? "medium",
      type: (raw["type"] as Ticket["type"] | undefined) ?? "task",
      assignee: String(raw["assignee"] ?? ""),
      estimate: (raw["estimate"] as Ticket["estimate"] | undefined) ?? "M",
      from: String(raw["from"] ?? ""),
      to: String(raw["to"] ?? ""),
      tags: (raw["tags"] as string[] | undefined) ?? [],
      blockedBy: (raw["blockedBy"] as string[] | undefined) ?? [],
      doc_refs: normalizeDocRefs((raw["doc_refs"] as DocRef[] | undefined) ?? []),
      linkedBranches: normalizeLinkedBranches(Array.isArray(raw["linkedBranches"]) ? raw["linkedBranches"] : []),
      linkedCommits: normalizeLinkedCommits((raw["linkedCommits"] as Ticket["linkedCommits"] | undefined) ?? []),
      comments: normalizeComments((raw["comments"] as Comment[] | undefined) ?? []),
      subTickets: normalizeSubTickets((raw["subTickets"] as Ticket["subTickets"] | undefined) ?? []),
      nextSubTicketCounter: Number(raw["nextSubTicketCounter"] ?? 0),
      createdAt: normalizeTimestamp(raw["createdAt"]),
      updatedAt: normalizeTimestamp(raw["updatedAt"]),
      resolvedAt: normalizeOptionalTimestamp(raw["resolvedAt"]),
    };
  }

  private addDocRef(existing: DocRef[], input: AddDocRefInput, actor: string, now: string): DocRef[] {
    const next = existing.filter((ref) => ref.path !== input.path).map((ref) => ({ ...ref, primary: input.primary ? false : ref.primary }));
    next.push({ type: input.type ?? "attachment", path: input.path, primary: input.primary ?? false, addedAt: now, addedBy: input.addedBy ?? actor });
    return next;
  }

  private writeTicket(ticket: Ticket): void {
    writeFileSync(this.ticketPath(ticket.id), JSON.stringify(ticket, null, 2));
  }

  private appendAudit(ticketId: string, action: AuditEntry["action"], actor: string, changes: AuditEntry["changes"]): void {
    this.appendAudits([{ ticketId, action, actor, changes }]);
  }

  private appendAudits(intents: AuditIntent[]): void {
    if (intents.length === 0) return;
    const entries = intents.map((intent): AuditEntry => ({
      ticket_id: intent.ticketId,
      action: intent.action,
      actor: intent.actor,
      timestamp: nowUtc(),
      changes: intent.changes,
    }));
    writeFileSync(resolve(this.dir, "audit.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "a" });
  }

  private readAuditSnapshot(): string | undefined {
    const path = resolve(this.dir, "audit.jsonl");
    return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  }

  private restoreAuditSnapshot(snapshot: string | undefined): void {
    const path = resolve(this.dir, "audit.jsonl");
    if (snapshot === undefined) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    writeFileSync(path, snapshot);
  }
}

function withTicketTransactionMutex<T>(dir: string, operation: () => T): T {
  const mutexPath = resolve(dir, TICKET_TRANSACTION_MUTEX_FILE);
  if (realpathSync(dir) !== resolve(dir)) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
  // This owner is now reachable from a finite native writer. Never chmod or
  // lock through an aliased/special file; pin the verified inode for flock.
  const descriptor = openSync(mutexPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const mutex = fstatSync(descriptor);
    if (!mutex.isFile() || mutex.nlink !== 1) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
    fchmodSync(descriptor, 0o600);
    const pinnedMutexPath = `/proc/${process.pid}/fd/${descriptor}`;
    const signalDirectory = mkdtempSync(join(tmpdir(), "pa-ticket-transaction-"));
    const readyPath = join(signalDirectory, "ready");
    const donePath = join(signalDirectory, "done");
    const script = "trap 'rm -f -- \"$1\"; : > \"$2\"' EXIT; : > \"$1\"; IFS= read -r _";
    const holder = spawn("flock", ["--exclusive", "--wait", String(TICKET_TRANSACTION_MUTEX_TIMEOUT_MS / 1000), pinnedMutexPath, "/bin/sh", "-c", script, "pa-ticket-transaction", readyPath, donePath], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    holder.on("error", () => { /* handshake timeout reports helper startup failure */ });
    holder.stdin.on("error", () => { /* handshake timeout reports helper failure */ });
    try {
      waitForTicketTransactionPath(readyPath, "acquire");
      const currentMutex = statSync(mutexPath);
      if (realpathSync(dir) !== resolve(dir) || realpathSync(mutexPath) !== mutexPath || currentMutex.dev !== mutex.dev || currentMutex.ino !== mutex.ino || currentMutex.nlink !== 1) throw new TicketCreateIntentError("TICKET_CREATE_UNCERTAIN");
      return operation();
    } finally {
      holder.stdin.end("release\n");
      try { waitForTicketTransactionPath(donePath, "release"); }
      catch { holder.kill("SIGKILL"); }
      rmSync(signalDirectory, { recursive: true, force: true });
    }
  } finally { closeSync(descriptor); }
}

function waitForTicketTransactionPath(path: string, action: string): void {
  const deadline = Date.now() + TICKET_TRANSACTION_MUTEX_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`ticket-store: could not ${action} transaction mutex within ${TICKET_TRANSACTION_MUTEX_TIMEOUT_MS}ms`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TICKET_TRANSACTION_MUTEX_POLL_MS);
  }
}

function assertLifecycleOwnership(status: TicketStatus | undefined, context: TicketMutationContext): void {
  if (status !== undefined && (context.privileged !== true || (context.team === "builder" && context.mode === "implement"))) {
    throw new Error("Ticket status transitions belong to the parent flow; implement-child agents must report completion without changing status.");
  }
}

export function resolveTrustedTicketMutationContext(principal: TicketMutationPrincipal = { deploymentId: process.env["PA_DEPLOYMENT_ID"], operator: !process.env["PA_DEPLOYMENT_ID"] }, allowLocalOperator = true): TicketMutationContext {
  const deploymentId = principal.deploymentId;
  if (principal.operator === true && allowLocalOperator) return { privileged: true };
  if (!deploymentId) return { privileged: false };
  const deployment = queryDeploymentStatus(deploymentId);
  if (!deployment || deployment.status !== "running") return { privileged: false };
  return { team: deployment.team, mode: deployment.mode, privileged: true };
}

function normalizeTimestamp(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? parseTimestamp(value).toISOString() : nowUtc();
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? parseTimestamp(value).toISOString() : null;
}

function normalizeDocRefs(refs: DocRef[]): DocRef[] {
  return refs.map((ref) => ({ ...ref, addedAt: normalizeTimestamp(ref.addedAt) }));
}

function normalizeComments(comments: Comment[]): Comment[] {
  return comments.map((comment) => ({ ...comment, timestamp: normalizeTimestamp(comment.timestamp), ...(comment.editedAt ? { editedAt: normalizeTimestamp(comment.editedAt) } : {}) }));
}

function normalizeSubTickets(subTickets: SubTicket[]): SubTicket[] {
  return subTickets.map((subTicket) => ({ ...subTicket, createdAt: normalizeTimestamp(subTicket.createdAt), updatedAt: normalizeTimestamp(subTicket.updatedAt) }));
}

function normalizeLinkedBranches(branches: unknown[]): LinkedBranch[] {
  return branches.map((value) => {
    const branch = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const legacySha = nonEmptyString(branch["sha"]);
    const headSha = nonEmptyString(branch["headSha"]) ?? legacySha;
    const baseSha = nonEmptyString(branch["baseSha"]);
    const explicitState = branch["state"];
    const state = explicitState === "planned" || explicitState === "materialized"
      ? explicitState
      : headSha ? "materialized" : "planned";
    return {
      repo: String(branch["repo"] ?? ""),
      branch: String(branch["branch"] ?? ""),
      state,
      ...(baseSha ? { baseSha } : {}),
      ...(headSha ? { headSha, sha: headSha } : {}),
      linkedAt: normalizeTimestamp(branch["linkedAt"]),
      linkedBy: String(branch["linkedBy"] ?? "pa-core"),
    };
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeLinkedCommits(commits: LinkedCommit[]): LinkedCommit[] {
  return commits.map((commit) => ({ ...commit, timestamp: normalizeTimestamp(commit.timestamp), linkedAt: normalizeTimestamp(commit.linkedAt) }));
}

function matchesFilters(ticket: Ticket, filters: TicketListFilters): boolean {
  if (filters.project && ticket.project !== filters.project) return false;
  if (filters.status && ticket.status !== filters.status) return false;
  if (filters.assignee && !matchAssignee(ticket.assignee, filters.assignee)) return false;
  if (filters.priority && ticket.priority !== filters.priority) return false;
  if (filters.type && ticket.type !== filters.type) return false;
  if (filters.tags?.some((tag) => !ticket.tags.includes(tag))) return false;
  if (filters.excludeTags?.some((tag) => ticket.tags.includes(tag))) return false;
  if (filters.excludeTypes?.some((type) => ticket.type === type)) return false;
  if (filters.search) {
    const haystack = `${ticket.id} ${ticket.title} ${ticket.summary} ${ticket.description}`.toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

function diffTicket(before: Ticket, after: Ticket): Record<string, [unknown, unknown]> {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const key of Object.keys(after) as Array<keyof Ticket>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = [before[key], after[key]];
  }
  return changes;
}

type AuditAppender = (ticketId: string, action: AuditEntry["action"], actor: string, changes: AuditEntry["changes"]) => void;

type AuditIntent = {
  ticketId: string;
  action: AuditEntry["action"];
  actor: string;
  changes: AuditEntry["changes"];
};

function applyLinkedBranchMutation(id: string, ticket: Ticket, add: AddLinkedBranchInput | undefined, remove: string | undefined, actor: string, appendAudit: AuditAppender, expected?: TicketLinkedHeadExpectation): Ticket {
  let linkedBranches = ticket.linkedBranches;
  if (remove) {
    const matches = linkedBranchSelectorMatches(linkedBranches, remove);
    if (!remove.includes(":") && matches.length > 1) {
      throw new Error(linkedBranchAmbiguityDiagnostic(id, remove, matches.length));
    }
    if (matches.length > 0) {
      const matched = new Set(matches);
      linkedBranches = linkedBranches.filter((branch) => !matched.has(branch));
      appendAudit(id, "branch_link_removed", actor, { branch: [matches.length === 1 ? matches[0] : matches, null] });
    }
  }
  if (add) {
    const resolvedBranch = resolveLinkedBranch(add, ticket, actor);
    const repositoryBranches = linkedBranches.filter((branch) => branch.repo === resolvedBranch.repo);
    const exactMatches = repositoryBranches.filter((branch) => branch.branch === resolvedBranch.branch);
    if (repositoryBranches.length > exactMatches.length) {
      throw new Error(`Ambiguous linked-branch evidence for ${id} in "${resolvedBranch.repo}". Correction: remove the other repository branch before linking "${resolvedBranch.branch}".`);
    }
    if (exactMatches.length > 1) {
      throw new Error(`Duplicate linked-branch evidence for ${id}: found ${exactMatches.length} entries for "${resolvedBranch.repo}|${resolvedBranch.branch}". Correction: retain one entry before retrying.`);
    }
    const existing = exactMatches[0];
    if (expected && (expected.repo !== resolvedBranch.repo || expected.branch !== resolvedBranch.branch
      || existing?.state !== "materialized" || existing.baseSha !== expected.baseSha || existing.headSha !== expected.expectedHeadSha
      || resolvedBranch.state !== "materialized" || resolvedBranch.headSha !== expected.headSha)) {
      throw new Error("Ticket linked-HEAD refresh precondition changed; no ticket update was published");
    }
    if (existing?.state === "planned" && resolvedBranch.state === "planned") {
      throw new Error(`Duplicate planned linked branch for ${id}: "${resolvedBranch.repo}|${resolvedBranch.branch}" is already recorded. Correction: materialize the branch or keep the existing intent.`);
    }
    if (existing?.state === "materialized" && resolvedBranch.state === "planned") {
      throw new Error(`Authenticated branch "${resolvedBranch.repo}|${resolvedBranch.branch}" disappeared after materialization. Correction: restore or explicitly reconcile the local branch; its materialized evidence was preserved.`);
    }
    const newBranch = mergeLinkedBranchEvidence(existing, resolvedBranch);
    linkedBranches = upsertLinkedBranch(linkedBranches, newBranch);
    appendAudit(id, "branch_link_added", actor, { branch: [existing ?? null, newBranch] });
  }
  return linkedBranches === ticket.linkedBranches ? ticket : { ...ticket, linkedBranches };
}

function applyLinkedCommitMutation(id: string, ticket: Ticket, add: AddLinkedCommitInput | undefined, remove: string | undefined, actor: string, appendAudit: AuditAppender): Ticket {
  let linkedCommits = ticket.linkedCommits;
  if (remove) {
    const before = linkedCommits;
    linkedCommits = linkedCommits.filter((commit) => commit.sha !== remove);
    if (linkedCommits.length !== before.length) appendAudit(id, "commit_link_removed", actor, { sha: [remove, null] });
  }
  if (add) {
    const newCommit = resolveLinkedCommit(add, actor);
    const before = linkedCommits;
    linkedCommits = upsertLinkedCommit(linkedCommits, newCommit);
    appendAudit(id, "commit_link_added", actor, { commit: [before.find((commit) => commit.sha === newCommit.sha) ?? null, newCommit] });
  }
  return linkedCommits === ticket.linkedCommits ? ticket : { ...ticket, linkedCommits };
}

function mergeLinkedBranchEvidence(existing: LinkedBranch | undefined, resolved: LinkedBranch): LinkedBranch {
  if (!existing) return resolved;
  if (resolved.state !== "materialized" || !resolved.headSha) return existing;
  const baseSha = existing.state === "materialized" ? existing.baseSha : resolved.baseSha;
  const { baseSha: _resolvedBaseSha, ...resolvedWithoutBase } = resolved;
  return {
    ...resolvedWithoutBase,
    ...(baseSha ? { baseSha } : {}),
    linkedAt: existing.linkedAt,
    linkedBy: existing.linkedBy,
  };
}

function upsertLinkedBranch(branches: LinkedBranch[], next: LinkedBranch): LinkedBranch[] {
  const index = branches.findIndex((branch) => branch.repo === next.repo && branch.branch === next.branch);
  if (index < 0) return [...branches, next];
  return branches.map((branch, i) => (i === index ? next : branch));
}

function upsertLinkedCommit(commits: LinkedCommit[], next: LinkedCommit): LinkedCommit[] {
  const index = commits.findIndex((commit) => commit.sha === next.sha);
  if (index < 0) return [...commits, next];
  return commits.map((commit, i) => (i === index ? { ...commit, ...next } : commit));
}

function linkedBranchSelectorMatches(branches: LinkedBranch[], selector: string): LinkedBranch[] {
  if (!selector.includes(":")) return branches.filter((branch) => branch.repo === selector);
  return branches.filter((branch) => `${branch.repo}:${branch.branch}` === selector);
}

function ticketsEqual(left: Ticket, right: Ticket): boolean {
  return isDeepStrictEqual(left, right);
}

function linkedBranchAmbiguityDiagnostic(ticketId: string, selector: string, count: number): string {
  return boundedFiveFieldDiagnostic({
    condition: "Linked-branch removal rejected before persistence.",
    source: `TicketStore.update ticket ${boundedDiagnosticValue(ticketId)} selector ${boundedDiagnosticValue(selector)}.`,
    reason: `Bare repository selector matched ${count} normalized records; removal is ambiguous.`,
    correction: "Retain one repository record or use an exact repo:branch selector.",
    resumeAction: "Retry only after the ticket has one unambiguous match or with the intended exact selector.",
  });
}

function linkedBranchPostconditionDiagnostic(ticketId: string, selector: string | undefined, cause: unknown, restored: boolean): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return boundedFiveFieldDiagnostic({
    condition: "Ticket update postcondition failed.",
    source: `TicketStore.update ticket ${boundedDiagnosticValue(ticketId)}${selector ? ` selector ${boundedDiagnosticValue(selector)}` : ""}.`,
    reason: `${boundedDiagnosticValue(reason)} Prior normalized snapshot ${restored ? "was restored and verified" : "could not be restored and verified"}.`,
    correction: "Reconcile disk-backed ticket storage and preserve the prior snapshot before retrying.",
    resumeAction: "Retry the complete update only after readback and restoration storage are healthy.",
  });
}

function boundedDiagnosticValue(value: string): string {
  const limit = 320;
  return value.length <= limit ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, limit))}…`;
}

function boundedFiveFieldDiagnostic(fields: { condition: string; source: string; reason: string; correction: string; resumeAction: string }): string {
  const diagnostic = [
    `Condition: ${fields.condition}`,
    `Source: ${fields.source}`,
    `Reason: ${fields.reason}`,
    `Correction: ${fields.correction}`,
    `Resume Action: ${fields.resumeAction}`,
  ].join("\n");
  return diagnostic.slice(0, 2000);
}
