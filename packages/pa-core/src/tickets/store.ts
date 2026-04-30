import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTicketsDir } from "../paths.js";
import { resolveProject } from "../repos.js";
import { nowUtc, parseTimestamp } from "../time.js";
import { resolveLinkedBranch, resolveLinkedCommit } from "./git-validation.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./types.js";
import { matchAssignee } from "./validate.js";
import type { AddDocRefInput, AddLinkedBranchInput, AddLinkedCommitInput, AuditEntry, Comment, CounterStore, CreateTicketInput, DocRef, LinkedBranch, LinkedCommit, SubTicket, Ticket, TicketListFilters, TicketStatus, UpdateTicketInput } from "./types.js";

const VALID_STATUSES = new Set<TicketStatus>([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);

export class TicketStore {
  private readonly dir: string;

  constructor(dir = getTicketsDir()) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  create(input: CreateTicketInput, actor = "pa-core"): Ticket {
    const { key, prefix } = resolveProject(input.project);
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
  }

  get(id: string): Ticket | undefined {
    const path = this.ticketPath(id);
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (raw["_alias"] === true && typeof raw["movedTo"] === "string") return this.get(raw["movedTo"]);
    return this.normalizeTicket(raw);
  }

  update(id: string, input: UpdateTicketInput, actor = "pa-core"): Ticket {
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
    let next: Ticket = { ...current, ...rest, updatedAt: nowUtc() };
    if (input.status && TERMINAL_STATUSES.includes(input.status)) next.resolvedAt = next.resolvedAt ?? next.updatedAt;
    if (input.status && !TERMINAL_STATUSES.includes(input.status)) next.resolvedAt = null;
    if (addDocRef) next = { ...next, doc_refs: this.addDocRef(next.doc_refs, addDocRef, actor, next.updatedAt) };
    if (removeDocRef) next = { ...next, doc_refs: next.doc_refs.filter((ref) => ref.path !== removeDocRef) };
    next = applyLinkedBranchMutation(id, next, addLinkedBranch, removeLinkedBranch, actor, this.appendAudit.bind(this));
    next = applyLinkedCommitMutation(id, next, addLinkedCommit, removeLinkedCommit, actor, this.appendAudit.bind(this));

    const changes = diffTicket(current, next);
    this.writeTicket(next);
    this.appendAudit(id, "updated", actor, changes);
    return next;
  }

  comment(id: string, author: string, content: string): Comment {
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket not found: ${id}`);
    const now = nowUtc();
    const comment: Comment = { id: `c-${now.replace(/[^0-9]/g, "")}`, author, content, timestamp: now };
    this.writeTicket({ ...ticket, comments: [...ticket.comments, comment], updatedAt: now });
    this.appendAudit(id, "commented", author, { comments: [ticket.comments.length, ticket.comments.length + 1] });
    return comment;
  }

  editComment(id: string, commentId: string, content: string, actor = "pa-core"): { ticket: Ticket; comment: Comment } {
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
  }

  deleteComment(id: string, commentId: string, actor = "pa-core"): Ticket {
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket not found: ${id}`);
    const comments = ticket.comments.filter((comment) => comment.id !== commentId);
    if (comments.length === ticket.comments.length) throw new Error(`Comment not found: ${commentId}`);
    const next = { ...ticket, comments, updatedAt: nowUtc() };
    this.writeTicket(next);
    this.appendAudit(id, "updated", actor, { comments: [ticket.comments.length, comments.length] });
    return next;
  }

  attach(id: string, path: string, actor = "pa-core"): Ticket {
    return this.update(id, { add_doc_ref: { type: "attachment", path } }, actor);
  }

  move(id: string, project: string, actor = "pa-core"): Ticket {
    const current = this.get(id);
    if (!current) throw new Error(`Ticket not found: ${id}`);
    const { key, prefix } = resolveProject(project);
    const newId = this.allocateId(prefix);
    const now = nowUtc();
    const moved = this.normalizeTicket({ ...current, id: newId, project: key, updatedAt: now });
    this.writeTicket(moved);
    writeFileSync(this.ticketPath(id), JSON.stringify({ _alias: true, movedTo: newId, movedAt: now, movedBy: actor }, null, 2));
    this.appendAudit(id, "updated", actor, { movedTo: [id, newId] });
    this.appendAudit(newId, "created", actor, { movedFrom: [id, newId] });
    return moved;
  }

  delete(id: string, actor = "pa-core", hard = false): void {
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket not found: ${id}`);
    if (hard) {
      unlinkSync(this.ticketPath(id));
      this.appendAudit(id, "deleted", actor, { hard: [false, true] });
      return;
    }
    this.update(id, { status: "cancelled" }, actor);
    this.appendAudit(id, "deleted", actor, { status: [ticket.status, "cancelled"] });
  }

  addSubTicket(parentId: string, input: Pick<SubTicket, "title" | "summary" | "assignee" | "priority" | "estimate">, actor = "pa-core"): { ticket: Ticket; subTicket: SubTicket } {
    const ticket = this.get(parentId);
    if (!ticket) throw new Error(`Ticket not found: ${parentId}`);
    const now = nowUtc();
    const nextCounter = ticket.nextSubTicketCounter + 1;
    const subTicket: SubTicket = { id: `${ticket.id}-ST-${nextCounter}`, title: input.title, summary: input.summary, assignee: input.assignee, priority: input.priority, estimate: input.estimate, status: "open", createdAt: now, updatedAt: now };
    const next = { ...ticket, subTickets: [...ticket.subTickets, subTicket], nextSubTicketCounter: nextCounter, updatedAt: now };
    this.writeTicket(next);
    this.appendAudit(parentId, "updated", actor, { subTickets: [ticket.subTickets.length, next.subTickets.length] });
    return { ticket: next, subTicket };
  }

  updateSubTicket(parentId: string, subTicketId: string, input: Partial<Pick<SubTicket, "title" | "summary" | "status" | "assignee" | "priority" | "estimate">>, actor = "pa-core"): { ticket: Ticket; subTicket: SubTicket } {
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

  readAudit(): AuditEntry[] {
    const path = resolve(this.dir, "audit.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditEntry);
  }

  private ticketPath(id: string): string {
    return resolve(this.dir, `${id}.json`);
  }

  private counterPath(): string {
    return resolve(this.dir, "counter.json");
  }

  private allocateId(prefix: string): string {
    const path = this.counterPath();
    const counters = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as CounterStore) : {};
    const next = (counters[prefix] ?? 0) + 1;
    counters[prefix] = next;
    writeFileSync(path, JSON.stringify(counters, null, 2));
    return `${prefix}-${String(next).padStart(3, "0")}`;
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
      linkedBranches: normalizeLinkedBranches((raw["linkedBranches"] as Ticket["linkedBranches"] | undefined) ?? []),
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
    const entry: AuditEntry = { ticket_id: ticketId, action, actor, timestamp: nowUtc(), changes };
    writeFileSync(resolve(this.dir, "audit.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
  }
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

function normalizeLinkedBranches(branches: LinkedBranch[]): LinkedBranch[] {
  return branches.map((branch) => ({ ...branch, linkedAt: normalizeTimestamp(branch.linkedAt) }));
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

function applyLinkedBranchMutation(id: string, ticket: Ticket, add: AddLinkedBranchInput | undefined, remove: string | undefined, actor: string, appendAudit: AuditAppender): Ticket {
  let linkedBranches = ticket.linkedBranches;
  if (remove) {
    const before = linkedBranches;
    linkedBranches = linkedBranches.filter((branch) => `${branch.repo}:${branch.branch}` !== remove);
    if (linkedBranches.length !== before.length) appendAudit(id, "branch_link_removed", actor, { branch: [remove, null] });
  }
  if (add) {
    const newBranch = resolveLinkedBranch(add, actor);
    const before = linkedBranches;
    linkedBranches = upsertLinkedBranch(linkedBranches, newBranch);
    appendAudit(id, "branch_link_added", actor, { branch: [before.find((branch) => branch.repo === newBranch.repo && branch.branch === newBranch.branch) ?? null, newBranch] });
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

function upsertLinkedBranch(branches: LinkedBranch[], next: LinkedBranch): LinkedBranch[] {
  const index = branches.findIndex((branch) => branch.repo === next.repo && branch.branch === next.branch);
  if (index < 0) return [...branches, next];
  return branches.map((branch, i) => (i === index ? { ...branch, ...next } : branch));
}

function upsertLinkedCommit(commits: LinkedCommit[], next: LinkedCommit): LinkedCommit[] {
  const index = commits.findIndex((commit) => commit.sha === next.sha);
  if (index < 0) return [...commits, next];
  return commits.map((commit, i) => (i === index ? { ...commit, ...next } : commit));
}
