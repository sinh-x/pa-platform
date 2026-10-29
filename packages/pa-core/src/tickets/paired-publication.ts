import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openArtifactDirectory, readArtifactFileAt } from "../artifacts/manifest.js";
import { digest, MAX_WORKFLOW_BYTES, reject, relativePath } from "../workflows/contracts.js";
import { TicketStore } from "./store.js";
import type { Ticket } from "./types.js";

export interface PublicationMember { path: string; sha256: string; raw: Uint8Array }
/** Trusted adapter derives this ONLY from an explicit retained attempt whose
 * publication outcome was completed. It is not a public request field. */
export interface TicketPublicationPredecessor { requirements: PublicationMember; uat: PublicationMember; queued: boolean }
export interface TicketPublicationPair { ticket: string; project: string; requirements: PublicationMember; uat: PublicationMember; predecessor?: TicketPublicationPredecessor }
export type PairObservation = "absent" | "complete" | "conflict" | "unknown";

/** Canonical artifact publication is owned by the existing ticket transaction, not a new ledger.
 * Missing directories are prerequisites; no allocation, overwrite, cleanup or legacy approval parsing. */
export class TicketPairPublication {
  constructor(private readonly store: TicketStore, private readonly artifactRoot: string) {}
  private ticket(pair: TicketPublicationPair): Ticket {
    const ticket = this.store.get(pair.ticket);
    if (!ticket || ticket.id !== pair.ticket || ticket.project !== pair.project) reject("WORKFLOW_AUTHORITY");
    return ticket;
  }
  private inspect(member: PublicationMember): "absent" | "exact" | "conflict" | "unknown" {
    let parent: number | undefined;
    try {
      relativePath(member.path);
      const path = join(this.artifactRoot, member.path);
      parent = openArtifactDirectory(dirname(path), "ARTIFACT_STALE");
      try { lstatSync(`/proc/self/fd/${parent}/${basename(path)}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw e; }
      const raw = readArtifactFileAt(parent, basename(path), MAX_WORKFLOW_BYTES, "ARTIFACT_STALE");
      return digest(raw) === member.sha256 ? "exact" : "conflict";
    } catch { return "unknown"; }
    finally { if (parent !== undefined) closeSync(parent); }
  }
  observe(pair: TicketPublicationPair): PairObservation {
    const ticket = this.ticket(pair), previous = pair.predecessor;
    const values = [this.inspect(pair.requirements), this.inspect(pair.uat)];
    if (values.includes("conflict")) return "conflict";
    if (values.includes("unknown")) return "unknown";
    const primaries = ticket.doc_refs.filter(ref => ref.primary);
    if (primaries.length > 1 || primaries.some(ref => ref.type !== "requirements" || (ref.path !== pair.requirements.path && ref.path !== previous?.requirements.path))) return "conflict";
    const reqRefs = ticket.doc_refs.filter(ref => ref.path === pair.requirements.path);
    const uatRefs = ticket.doc_refs.filter(ref => ref.path === pair.uat.path);
    if (reqRefs.length > 1 || uatRefs.length > 1 || reqRefs.some(ref => ref.type !== "requirements") || uatRefs.some(ref => ref.type !== "uat" || ref.primary)) return "conflict";
    if (previous) {
      // Promotion never edits/replaces historical bytes or invents a missing
      // predecessor ref. Both the old-primary and already-promoted states are
      // recognized, so an interrupted effect can be settled without a retry.
      const oldValues = [this.inspect(previous.requirements), this.inspect(previous.uat)];
      if (oldValues.includes("conflict")) return "conflict";
      if (!oldValues.every(v => v === "exact")) return "unknown";
      const oldReq = ticket.doc_refs.filter(ref => ref.path === previous.requirements.path);
      const oldUat = ticket.doc_refs.filter(ref => ref.path === previous.uat.path);
      if (oldReq.length !== 1 || oldReq[0]!.type !== "requirements" || oldUat.length !== 1 || oldUat[0]!.type !== "uat" || oldUat[0]!.primary || primaries.length !== 1) return "conflict";
    }
    return values.every(v => v === "exact") && primaries.length === 1 && primaries[0]!.path === pair.requirements.path && reqRefs.length === 1 && uatRefs.length === 1 ? "complete" : "absent";
  }
  private requireAbsent(pair: TicketPublicationPair): void {
    if (this.observe(pair) !== "absent") reject("WORKFLOW_UNCERTAIN");
    if (pair.predecessor && !["requirement-review", "pending-approval", "pending-implementation", "implementing"].includes(this.ticket(pair).status)) reject("WORKFLOW_CONFLICT");
  }
  private queueComplete(pair: TicketPublicationPair, ticket = this.ticket(pair)): boolean {
    return ticket.assignee === "builder/team-manager" && (ticket.status === "pending-implementation" || (pair.predecessor?.queued === true && ticket.status === "implementing"));
  }
  publish(pair: TicketPublicationPair, authorize: () => void): void {
    this.store.withWorkflowTransaction(() => {
      const initial = this.observe(pair); if (initial === "complete") return;
      if (initial !== "absent") reject("WORKFLOW_UNCERTAIN");
      this.requireAbsent(pair);
      for (const member of [pair.requirements, pair.uat]) {
        if (digest(member.raw) !== member.sha256) reject("WORKFLOW_SOURCE");
        const observed = this.inspect(member); if (observed === "exact") continue;
        if (observed !== "absent") reject("WORKFLOW_UNCERTAIN");
        const path = join(this.artifactRoot, member.path);
        const parent = openArtifactDirectory(dirname(path), "ARTIFACT_STALE"); let fd: number | undefined;
        try {
          authorize(); this.requireAbsent(pair);
          // O_EXCL never overwrites a competing file. An interrupted partial write stays unknown/conflicting.
          if (realpathSync(`/proc/self/fd/${parent}`) !== dirname(path)) reject("WORKFLOW_SOURCE");
          fd = openSync(`/proc/self/fd/${parent}/${basename(path)}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          if (!fstatSync(fd).isFile()) reject("WORKFLOW_SOURCE");
          writeFileSync(fd, member.raw); fsyncSync(fd); closeSync(fd); fd = undefined; fsyncSync(parent);
        } finally { if (fd !== undefined) closeSync(fd); closeSync(parent); }
        if (this.inspect(member) !== "exact") reject("WORKFLOW_UNCERTAIN");
      }
      for (const [member, type] of [[pair.requirements, "requirements"], [pair.uat, "uat"]] as const) {
        const ticket = this.ticket(pair);
        const primary = !pair.predecessor && type === "requirements";
        if (ticket.doc_refs.some(ref => ref.path === member.path && ref.type === type && (pair.predecessor || ref.primary === primary))) continue;
        authorize(); this.requireAbsent(pair);
        // Revised refs are paired BEFORE promoting the new requirements; old
        // ref metadata stays intact. The ordinary initial route keeps its two
        // attachment updates and existing audit semantics.
        this.store.update(pair.ticket, { add_doc_ref: { path: member.path, type, primary } }, "workflow/tickets");
      }
      if (this.observe(pair) !== "complete") {
        authorize(); this.requireAbsent(pair);
        const ticket = this.ticket(pair), primaries = ticket.doc_refs.filter(ref => ref.primary);
        if (!pair.predecessor || primaries.length !== 1 || primaries[0]!.path !== pair.predecessor.requirements.path
          || this.inspect(pair.requirements) !== "exact" || this.inspect(pair.uat) !== "exact"
          || !ticket.doc_refs.some(ref => ref.type === "requirements" && ref.path === pair.requirements.path)
          || !ticket.doc_refs.some(ref => ref.type === "uat" && ref.path === pair.uat.path && !ref.primary)) reject("WORKFLOW_UNCERTAIN");
        // One TicketStore update, under its SAME mutex: demote exactly the
        // authenticated predecessor and promote exactly the paired successor.
        // Preserve all historical addedAt/addedBy/title and unrelated refs.
        this.store.update(pair.ticket, { doc_refs: ticket.doc_refs.map(ref => ref.path === pair.requirements.path ? { ...ref, primary: true }
          : ref.path === pair.predecessor!.requirements.path ? { ...ref, primary: false } : ref) }, "workflow/tickets");
      }
      if (this.observe(pair) !== "complete") reject("WORKFLOW_UNCERTAIN");
    });
  }
  queue(pair: TicketPublicationPair, authorize: () => void): void {
    this.store.withWorkflowTransaction(() => {
      if (this.observe(pair) !== "complete") reject("WORKFLOW_UNCERTAIN");
      const ticket = this.ticket(pair);
      if (this.queueComplete(pair, ticket)) return;
      if (!["requirement-review", "pending-approval"].includes(ticket.status)) reject("WORKFLOW_CONFLICT");
      authorize();
      if (this.observe(pair) !== "complete") reject("WORKFLOW_UNCERTAIN");
      const current = this.ticket(pair);
      if (current.status !== ticket.status || current.assignee !== ticket.assignee) reject("WORKFLOW_CONFLICT");
      // TicketStore retains lifecycle ownership checks and its authenticated context.
      this.store.update(pair.ticket, { status: "pending-implementation", assignee: "builder/team-manager" }, "workflow/tickets");
    });
  }
  queued(pair: TicketPublicationPair): boolean {
    const ticket = this.ticket(pair);
    return this.observe(pair) === "complete" && this.queueComplete(pair, ticket);
  }
}
