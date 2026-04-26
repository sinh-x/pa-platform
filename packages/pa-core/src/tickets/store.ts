import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTicketsDir } from "../paths.js";
import { resolveProject } from "../repos.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./types.js";
import type { AddDocRefInput, AuditEntry, Comment, CounterStore, CreateTicketInput, DocRef, Ticket, TicketListFilters, TicketStatus, UpdateTicketInput } from "./types.js";

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
    const now = new Date().toISOString();
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

    const { add_doc_ref: addDocRef, remove_doc_ref: removeDocRef, ...rest } = input;
    let next: Ticket = { ...current, ...rest, updatedAt: new Date().toISOString() };
    if (input.status && TERMINAL_STATUSES.includes(input.status)) next.resolvedAt = next.resolvedAt ?? next.updatedAt;
    if (input.status && !TERMINAL_STATUSES.includes(input.status)) next.resolvedAt = null;
    if (addDocRef) next = { ...next, doc_refs: this.addDocRef(next.doc_refs, addDocRef, actor, next.updatedAt) };
    if (removeDocRef) next = { ...next, doc_refs: next.doc_refs.filter((ref) => ref.path !== removeDocRef) };

    const changes = diffTicket(current, next);
    this.writeTicket(next);
    this.appendAudit(id, "updated", actor, changes);
    return next;
  }

  comment(id: string, author: string, content: string): Comment {
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket not found: ${id}`);
    const now = new Date().toISOString();
    const comment: Comment = { id: `c-${now.replace(/[^0-9]/g, "")}`, author, content, timestamp: now };
    this.writeTicket({ ...ticket, comments: [...ticket.comments, comment], updatedAt: now });
    this.appendAudit(id, "commented", author, { comments: [ticket.comments.length, ticket.comments.length + 1] });
    return comment;
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
      doc_refs: (raw["doc_refs"] as DocRef[] | undefined) ?? [],
      linkedBranches: (raw["linkedBranches"] as Ticket["linkedBranches"] | undefined) ?? [],
      linkedCommits: (raw["linkedCommits"] as Ticket["linkedCommits"] | undefined) ?? [],
      comments: (raw["comments"] as Comment[] | undefined) ?? [],
      subTickets: (raw["subTickets"] as Ticket["subTickets"] | undefined) ?? [],
      nextSubTicketCounter: Number(raw["nextSubTicketCounter"] ?? 0),
      createdAt: String(raw["createdAt"] ?? new Date().toISOString()),
      updatedAt: String(raw["updatedAt"] ?? new Date().toISOString()),
      resolvedAt: (raw["resolvedAt"] as string | null | undefined) ?? null,
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
    const entry: AuditEntry = { ticket_id: ticketId, action, actor, timestamp: new Date().toISOString(), changes };
    writeFileSync(resolve(this.dir, "audit.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
  }
}

function matchesFilters(ticket: Ticket, filters: TicketListFilters): boolean {
  if (filters.project && ticket.project !== filters.project) return false;
  if (filters.status && ticket.status !== filters.status) return false;
  if (filters.assignee && ticket.assignee !== filters.assignee) return false;
  if (filters.priority && ticket.priority !== filters.priority) return false;
  if (filters.type && ticket.type !== filters.type) return false;
  if (filters.tags?.some((tag) => !ticket.tags.includes(tag))) return false;
  if (filters.excludeTags?.some((tag) => ticket.tags.includes(tag))) return false;
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
