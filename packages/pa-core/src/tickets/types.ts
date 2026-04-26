export type TicketStatus =
  | "idea"
  | "requirement-review"
  | "pending-approval"
  | "pending-implementation"
  | "implementing"
  | "review-uat"
  | "done"
  | "rejected"
  | "cancelled";

export const TERMINAL_STATUSES: TicketStatus[] = ["done", "rejected", "cancelled"];
export const ACTIVE_STATUSES: TicketStatus[] = ["idea", "requirement-review", "pending-approval", "pending-implementation", "implementing", "review-uat"];

export type TicketPriority = "critical" | "high" | "medium" | "low";
export type TicketType = "feature" | "bug" | "task" | "review-request" | "work-report" | "fyi" | "idea" | "question";
export type Estimate = "XS" | "S" | "M" | "L" | "XL";
export type SubTicketStatus = "open" | "in-progress" | "done";

export interface LinkedBranch {
  repo: string;
  branch: string;
  sha: string;
  linkedAt: string;
  linkedBy: string;
}

export interface LinkedCommit {
  repo: string;
  sha: string;
  message: string;
  author: string;
  timestamp: string;
  linkedAt: string;
  linkedBy: string;
}

export interface SubTicket {
  id: string;
  title: string;
  summary: string;
  status: SubTicketStatus;
  assignee: string;
  priority: TicketPriority;
  estimate: Estimate;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  editedAt?: string;
}

export interface DocRef {
  type: string;
  path: string;
  primary: boolean;
  addedAt: string;
  addedBy: string;
  title?: string;
}

export interface AuditEntry {
  ticket_id: string;
  action: "created" | "updated" | "commented" | "attached" | "doc_ref_added" | "doc_ref_removed" | "deleted";
  actor: string;
  timestamp: string;
  changes: Record<string, [unknown, unknown]>;
}

export interface Ticket {
  id: string;
  project: string;
  title: string;
  summary: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  assignee: string;
  estimate: Estimate;
  from: string;
  to: string;
  tags: string[];
  blockedBy: string[];
  doc_refs: DocRef[];
  linkedBranches: LinkedBranch[];
  linkedCommits: LinkedCommit[];
  comments: Comment[];
  subTickets: SubTicket[];
  nextSubTicketCounter: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export type CreateTicketInput = Omit<Ticket, "id" | "createdAt" | "updatedAt" | "resolvedAt" | "subTickets" | "nextSubTicketCounter" | "linkedBranches" | "linkedCommits"> & {
  resolvedAt?: string | null;
  linkedBranches?: LinkedBranch[];
  linkedCommits?: LinkedCommit[];
};

export interface AddDocRefInput {
  type?: string;
  path: string;
  primary?: boolean;
  addedBy?: string;
}

export type UpdateTicketInput = Partial<Omit<Ticket, "id" | "project" | "createdAt" | "subTickets" | "nextSubTicketCounter">> & {
  add_doc_ref?: AddDocRefInput;
  remove_doc_ref?: string;
};

export interface TicketListFilters {
  project?: string;
  status?: TicketStatus;
  assignee?: string;
  priority?: TicketPriority;
  type?: TicketType;
  tags?: string[];
  excludeTags?: string[];
  search?: string;
}

export type CounterStore = Record<string, number>;
