import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openArtifactDirectory, readArtifactFileAt } from "../artifacts/manifest.js";
import { digest, MAX_WORKFLOW_BYTES, reject, relativePath } from "../workflows/contracts.js";
import { TicketStore } from "./store.js";
import type { Ticket } from "./types.js";

export interface PublicationMember { path: string; sha256: string; raw: Uint8Array }
export interface TicketPublicationPair { ticket: string; project: string; requirements: PublicationMember; uat: PublicationMember }
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
    const ticket = this.ticket(pair);
    const values = [this.inspect(pair.requirements), this.inspect(pair.uat)];
    if (values.includes("conflict")) return "conflict";
    if (values.includes("unknown")) return "unknown";
    const primaries = ticket.doc_refs.filter(ref => ref.type === "requirements" && ref.primary);
    if (primaries.some(ref => ref.path !== pair.requirements.path)) return "conflict";
    const reqRefs = ticket.doc_refs.filter(ref => ref.path === pair.requirements.path);
    const uatRefs = ticket.doc_refs.filter(ref => ref.path === pair.uat.path);
    if (reqRefs.some(ref => ref.type !== "requirements") || uatRefs.some(ref => ref.type !== "uat" || ref.primary)) return "conflict";
    return values.every(v => v === "exact") && primaries.length === 1 && reqRefs.length === 1 && uatRefs.length === 1 ? "complete" : "absent";
  }
  publish(pair: TicketPublicationPair, authorize: () => void): void {
    this.store.withWorkflowTransaction(() => {
      const initial = this.observe(pair); if (initial === "complete") return;
      if (initial !== "absent") reject("WORKFLOW_UNCERTAIN");
      for (const member of [pair.requirements, pair.uat]) {
        if (digest(member.raw) !== member.sha256) reject("WORKFLOW_SOURCE");
        const observed = this.inspect(member); if (observed === "exact") continue;
        if (observed !== "absent") reject("WORKFLOW_UNCERTAIN");
        const path = join(this.artifactRoot, member.path);
        const parent = openArtifactDirectory(dirname(path), "ARTIFACT_STALE"); let fd: number | undefined;
        try {
          authorize();
          // O_EXCL never overwrites a competing file. An interrupted partial write stays unknown/conflicting.
          if (realpathSync(`/proc/self/fd/${parent}`) !== dirname(path)) reject("WORKFLOW_SOURCE");
          fd = openSync(`/proc/self/fd/${parent}/${basename(path)}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          if (!fstatSync(fd).isFile()) reject("WORKFLOW_SOURCE");
          writeFileSync(fd, member.raw); fsyncSync(fd); closeSync(fd); fd = undefined; fsyncSync(parent);
        } finally { if (fd !== undefined) closeSync(fd); closeSync(parent); }
        if (this.inspect(member) !== "exact") reject("WORKFLOW_UNCERTAIN");
      }
      for (const [member, type, primary] of [[pair.requirements, "requirements", true], [pair.uat, "uat", false]] as const) {
        const ticket = this.ticket(pair);
        if (ticket.doc_refs.some(ref => ref.path === member.path && ref.type === type && ref.primary === primary)) continue;
        authorize();
        this.store.update(pair.ticket, { add_doc_ref: { path: member.path, type, primary } }, "workflow/tickets");
      }
      if (this.observe(pair) !== "complete") reject("WORKFLOW_UNCERTAIN");
    });
  }
  queue(pair: TicketPublicationPair, authorize: () => void): void {
    this.store.withWorkflowTransaction(() => {
      if (this.observe(pair) !== "complete") reject("WORKFLOW_UNCERTAIN");
      const ticket = this.ticket(pair);
      if (ticket.status === "pending-implementation" && ticket.assignee === "builder/team-manager") return;
      if (!["requirement-review", "pending-approval"].includes(ticket.status)) reject("WORKFLOW_CONFLICT");
      authorize();
      // TicketStore retains lifecycle ownership checks and its authenticated context.
      this.store.update(pair.ticket, { status: "pending-implementation", assignee: "builder/team-manager" }, "workflow/tickets");
    });
  }
  queued(pair: TicketPublicationPair): boolean {
    const ticket = this.ticket(pair);
    return this.observe(pair) === "complete" && ticket.status === "pending-implementation" && ticket.assignee === "builder/team-manager";
  }
}
