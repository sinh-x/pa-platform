import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openArtifactDirectory, readArtifactFileAt } from "../artifacts/manifest.js";
import { documentDestination, documentReject, DOCUMENT_LIMITS, type DocumentMember, type DocumentPackage } from "../documents/package-contract.js";
import { validateDocumentBytes } from "../documents/package-tools.js";
import { digest } from "../workflows/contracts.js";
import type { TicketStore } from "./store.js";
import type { DocRef, Ticket } from "./types.js";

export type PackageObservation = "absent" | "partial" | "complete" | "conflict" | "unknown";
const refType = (member: DocumentMember): DocRef["type"] => member.role === "requirements" ? "requirements" : member.role === "uat" ? "uat" : "attachment";
/** Extends the existing TicketStore mutex/audit owner. File effects are absent-
 * only and durable; filesystem and ticket writes are NOT claimed atomic. */
export class TicketPackagePublication {
  constructor(private readonly store: TicketStore, private readonly artifactRoot: string) {}
  private ticket(subject: DocumentPackage): Ticket {
    const ticket = this.store.get(subject.ticket);
    if (!ticket || ticket.project !== subject.repository.key) documentReject("DOCUMENT_AUTHORITY");
    return ticket;
  }
  /** Only the fixed publication subtree can be allocated. Every ancestor is pinned. */
  private directory(subject: DocumentPackage, create?: () => void): number | null {
    const parts = ["packages", subject.ticket, subject.packageId, `r${String(subject.revision).padStart(3, "0")}`];
    let fd = openArtifactDirectory(join(this.artifactRoot, "agent-teams/requirements/artifacts"), "ARTIFACT_STALE");
    try {
      for (const part of parts) {
        const path = `/proc/self/fd/${fd}/${part}`;
        if (create) { create(); try { mkdirSync(path, 0o700); fsyncSync(fd); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
        let next: number;
        try { next = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
        catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") { closeSync(fd); return null; } throw error; }
        closeSync(fd); fd = next;
      }
      const expected = dirname(join(this.artifactRoot, documentDestination(subject, subject.members[0]!)));
      if (realpathSync(`/proc/self/fd/${fd}`) !== expected) documentReject("DOCUMENT_SOURCE");
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  private inspect(subject: DocumentPackage, member: DocumentMember): "absent" | "exact" | "conflict" | "unknown" {
    let parent: number | null = null;
    try {
      parent = this.directory(subject); if (parent === null) return "absent";
      const name = basename(documentDestination(subject, member));
      try { lstatSync(`/proc/self/fd/${parent}/${name}`); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
      const bytes = readArtifactFileAt(parent, name, DOCUMENT_LIMITS.memberBytes, "ARTIFACT_STALE");
      return bytes.byteLength === member.bytes && digest(bytes) === member.sha256 ? "exact" : "conflict";
    } catch { return "unknown"; } finally { if (parent !== null) closeSync(parent); }
  }
  /** Recovery inspection is deliberately stricter than ordinary resumable publish.
   * It never creates a directory or repairs a ref, and needs no draft sources. */
  diagnose(subject: DocumentPackage) {
    const ticket = this.ticket(subject);
    if (ticket.doc_refs.length > 256 || Buffer.byteLength(JSON.stringify(ticket.doc_refs)) > 8192) documentReject("DOCUMENT_UNCERTAIN");
    const identity = (s: Stats) => ({ dev: String(s.dev), ino: String(s.ino), size: s.size, mode: s.mode, uid: s.uid, nlink: s.nlink, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
    const members = subject.members.map(member => {
      const path = documentDestination(subject, member), refs = ticket.doc_refs.filter(r => r.path === path);
      let parent: number | undefined;
      const ancestors: ReturnType<typeof identity>[] = [];
      let file: ReturnType<typeof identity> | null = null;
      let state: "absent" | "exact" | "conflict" | "unknown" = "unknown";
      try {
        let expectedParent = join(this.artifactRoot, "agent-teams/requirements/artifacts");
        parent = openArtifactDirectory(expectedParent, "ARTIFACT_STALE");
        let missing = false;
        for (const part of ["packages", subject.ticket, subject.packageId, `r${String(subject.revision).padStart(3, "0")}`]) {
          const stat = fstatSync(parent);
          if (stat.uid !== process.getuid?.() || stat.mode & 0o022) documentReject("DOCUMENT_SOURCE");
          ancestors.push(identity(stat));
          let next: number;
          try { next = openSync(`/proc/self/fd/${parent}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing = true; break; }
          closeSync(parent); parent = next; expectedParent = join(expectedParent, part);
        }
        if (missing) state = "absent";
        else {
          const stat = fstatSync(parent);
          if (stat.uid !== process.getuid?.() || stat.mode & 0o022 || realpathSync(`/proc/self/fd/${parent}`) !== dirname(join(this.artifactRoot, path))) documentReject("DOCUMENT_SOURCE");
          ancestors.push(identity(stat));
          const name = `/proc/self/fd/${parent}/${basename(path)}`;
          try { file = identity(lstatSync(name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (!file) state = "absent";
          else {
            if (file.uid !== process.getuid?.() || file.mode & 0o022 || file.nlink !== 1) documentReject("DOCUMENT_SOURCE");
            const bytes = readArtifactFileAt(parent, basename(path), DOCUMENT_LIMITS.memberBytes, "ARTIFACT_STALE");
            if (JSON.stringify(file) !== JSON.stringify(identity(lstatSync(name)))) documentReject("DOCUMENT_STALE");
            if (bytes.length !== member.bytes || digest(bytes) !== member.sha256) state = "conflict";
            else { validateDocumentBytes(member, bytes); state = "exact"; }
          }
        }
        // Detect directory replacement/mutation even on an absence observation.
        const pinned = ancestors.at(-1);
        if (!pinned || realpathSync(`/proc/self/fd/${parent}`) !== expectedParent || JSON.stringify(pinned) !== JSON.stringify(identity(fstatSync(parent)))) documentReject("DOCUMENT_STALE");
      } catch { state = "unknown"; }
      finally { if (parent !== undefined) closeSync(parent); }
      return { id: member.id, path, mediaType: member.mediaType, bytes: member.bytes, sha256: member.sha256, state, file, ancestors,
        refs, consistent: refs.length <= 1 && refs.every(r => r.type === refType(member) && !r.primary && state === "exact") };
    });
    const primaries = ticket.doc_refs.filter(r => r.primary);
    return { members, primaries, ticketState: { status: ticket.status, assignee: ticket.assignee }, refsSha256: digest(JSON.stringify(ticket.doc_refs)),
      eligible: primaries.length === 0 && members.every(m => (m.state === "absent" || m.state === "exact") && m.consistent),
      publication: this.observe(subject), limitations: "Point-in-time cooperating-owner observation; not hostile same-UID exclusion or filesystem/ticket/SQLite atomicity." };
  }
  observe(subject: DocumentPackage, predecessor?: DocumentPackage): PackageObservation {
    const ticket = this.ticket(subject), values = subject.members.map(m => this.inspect(subject, m));
    if (values.includes("conflict")) return "conflict";
    if (values.includes("unknown")) return "unknown";
    const requirements = subject.members.find(m => m.role === "requirements")!, path = documentDestination(subject, requirements);
    const oldRequirements = predecessor?.members.find(m => m.role === "requirements"), oldPath = predecessor && oldRequirements ? documentDestination(predecessor, oldRequirements) : null;
    const primaries = ticket.doc_refs.filter(r => r.primary);
    if (primaries.length > 1 || primaries.some(r => r.type !== "requirements" || (r.path !== path && r.path !== oldPath))) return "conflict";
    if (predecessor) {
      if (predecessor.ticket !== subject.ticket || predecessor.repository.key !== subject.repository.key || predecessor.repository.root !== subject.repository.root || primaries.length !== 1) return "conflict";
      for (const member of predecessor.members) {
        const value = this.inspect(predecessor, member); if (value === "conflict") return "conflict"; if (value !== "exact") return "unknown";
        const refs = ticket.doc_refs.filter(r => r.path === documentDestination(predecessor, member));
        if (refs.length !== 1 || refs[0]!.type !== refType(member) || (member.role !== "requirements" && refs[0]!.primary)) return "conflict";
      }
    }
    let refsPresent = 0;
    for (const member of subject.members) {
      const refs = ticket.doc_refs.filter(r => r.path === documentDestination(subject, member));
      if (refs.length > 1 || refs.some(r => r.type !== refType(member) || (member.role !== "requirements" && r.primary))) return "conflict";
      refsPresent += refs.length;
    }
    if (values.every(v => v === "exact") && refsPresent === subject.members.length && primaries.length === 1 && primaries[0]!.path === path) return "complete";
    return values.some(v => v === "exact") || refsPresent > 0 ? "partial" : "absent";
  }
  private writable(subject: DocumentPackage, predecessor?: DocumentPackage): void {
    if (!["absent", "partial"].includes(this.observe(subject, predecessor))) documentReject("DOCUMENT_UNCERTAIN");
    const ticket = this.ticket(subject);
    if (!["requirement-review", "pending-approval", "pending-implementation"].includes(ticket.status)
      || !["", "sinh", "requirements/team-manager", "builder/team-manager"].includes(ticket.assignee)
      || (ticket.assignee === "builder/team-manager" && ticket.status !== "pending-implementation")) documentReject("DOCUMENT_CONFLICT");
  }
  publish(subject: DocumentPackage, read: (sha256: string) => Uint8Array, authorize: () => void, predecessor?: DocumentPackage): void {
    this.store.withWorkflowTransaction(() => {
      authorize(); if (this.observe(subject, predecessor) === "complete") return;
      this.writable(subject, predecessor);
      const parent = this.directory(subject, () => { authorize(); this.writable(subject, predecessor); });
      if (parent === null) documentReject("DOCUMENT_UNCERTAIN");
      try {
        for (const member of subject.members) {
          if (this.inspect(subject, member) === "exact") continue;
          const bytes = read(member.sha256); validateDocumentBytes(member, bytes);
          authorize(); this.writable(subject, predecessor);
          if (realpathSync(`/proc/self/fd/${parent}`) !== dirname(join(this.artifactRoot, documentDestination(subject, member)))) documentReject("DOCUMENT_SOURCE");
          const fd = openSync(`/proc/self/fd/${parent}/${basename(documentDestination(subject, member))}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1) documentReject("DOCUMENT_SOURCE"); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
          fsyncSync(parent);
          if (this.inspect(subject, member) !== "exact") documentReject("DOCUMENT_UNCERTAIN");
        }
      } finally { closeSync(parent); }
      for (const member of subject.members) {
        const path = documentDestination(subject, member);
        if (this.ticket(subject).doc_refs.some(r => r.path === path)) continue;
        authorize(); this.writable(subject, predecessor);
        // ALL refs begin non-primary; full required set precedes promotion.
        this.store.update(subject.ticket, { add_doc_ref: { type: refType(member), path, primary: false } }, "documents/tickets");
      }
      authorize(); this.writable(subject, predecessor);
      if (!subject.members.every(member => this.inspect(subject, member) === "exact" && this.ticket(subject).doc_refs.some(r => r.path === documentDestination(subject, member) && r.type === refType(member)))) documentReject("DOCUMENT_UNCERTAIN");
      const primary = documentDestination(subject, subject.members.find(m => m.role === "requirements")!);
      this.store.update(subject.ticket, { doc_refs: this.ticket(subject).doc_refs.map(ref => ({ ...ref, primary: ref.path === primary })) }, "documents/tickets");
      if (this.observe(subject, predecessor) !== "complete") documentReject("DOCUMENT_UNCERTAIN");
    });
  }
  queue(subject: DocumentPackage, authorize: () => void, predecessor?: DocumentPackage): void {
    this.queueInternal(subject, authorize, predecessor, subject.effects.queue);
  }
  /** New finite native start scope, not a widening of old content/publish receipts.
   * The existing document owner MUST validate that exact new grant in authorize. */
  queueAutoStart(subject: DocumentPackage, authorize: () => void, predecessor?: DocumentPackage): void {
    this.queueInternal(subject, authorize, predecessor, true);
  }
  private queueInternal(subject: DocumentPackage, authorize: () => void, predecessor: DocumentPackage | undefined, queueAuthorized: boolean): void {
    this.store.withWorkflowTransaction(() => {
      authorize(); if (!queueAuthorized || this.observe(subject, predecessor) !== "complete") documentReject("DOCUMENT_AUTHORITY");
      const ticket = this.ticket(subject);
      if (ticket.status === "pending-implementation" && ticket.assignee === "builder/team-manager") return;
      if (!["requirement-review", "pending-approval", "pending-implementation"].includes(ticket.status) || !["", "sinh", "requirements/team-manager"].includes(ticket.assignee)) documentReject("DOCUMENT_CONFLICT");
      authorize();
      this.store.update(subject.ticket, { status: "pending-implementation", assignee: "builder/team-manager" }, "documents/tickets");
    });
  }
  queued(subject: DocumentPackage, predecessor?: DocumentPackage): boolean {
    const ticket = this.ticket(subject);
    return this.observe(subject, predecessor) === "complete" && ticket.status === "pending-implementation" && ticket.assignee === "builder/team-manager";
  }
}
