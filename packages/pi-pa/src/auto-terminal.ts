import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { AutoWaitlistError, assertUnmanagedOperator, workflowDigest, checkDocumentPackage, type DocumentPackage } from "@pa-platform/pa-core";

export interface AutoTerminal {
  authenticate(): void;
  display(text: string): void;
  choose(prompt: string, choices: readonly string[]): Promise<number>;
  /** Unsigned proposal data only; never an outcome/principal/approval port. */
  input?(prompt: string): Promise<string | null>;
}
export const autoVisibleTerminalText = (value: unknown): string => typeof value !== "string" ? "[unprintable text]" : value.replace(/\r\n/g, "\n").replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, c => {
  if (c === "\n" || c === "\t") return c;
  const point = c.codePointAt(0)!; return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, "0")}`;
});
const visible = autoVisibleTerminalText;
/** TTY is transport, not identity: the existing unmanaged-origin owner also
 * rejects environment-cleared descendants of managed agents on every read. */
export function nativeAutoTerminal(): AutoTerminal {
  const authenticate = () => {
    assertUnmanagedOperator();
    if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  };
  return { authenticate, display(text) { authenticate(); process.stderr.write(`${visible(text)}\n`); },
    async input(prompt) {
      authenticate(); const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      try { const answer = await reader.question(`${visible(prompt)}\nEmpty input cancels: `); authenticate(); return answer.trim() ? answer : null; }
      finally { reader.close(); }
    },
    async choose(prompt, choices) {
      authenticate();
      const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      try {
        process.stderr.write(`${visible(prompt)}\n0. Cancel (default)\n${choices.map((c, i) => `${i + 1}. ${visible(c)}`).join("\n")}\n`);
        const answer = await reader.question("Choice [0]: "); authenticate();
        if (!/^[1-9]\d{0,4}$/.test(answer) || Number(answer) > choices.length) return -1;
        return Number(answer) - 1;
      } finally { reader.close(); }
    } };
}
export interface AutoFullReview {
  subject: DocumentPackage; subjectSha256: string; documents: readonly Uint8Array[];
  startIntent: unknown; startSha256: string; documentScope: "none" | "queue-only" | "publish-and-queue";
}
export interface AutoNativeCapture {
  outcome: "approved" | "rejected" | "changes-requested" | "cancelled";
  principal: string; interactionId: string; evidenceSha256: string; evidence: Buffer;
}
export function displayAutoFullPackage(terminal: AutoTerminal, subject: DocumentPackage, documents: readonly Uint8Array[]): void {
  terminal.authenticate();
  if (!checkDocumentPackage(subject, documents).structuralPass || subject.members.some(m => !m.mediaType.startsWith("text/"))) throw new AutoWaitlistError("AUTO_SOURCE");
  terminal.display(`Immutable full package inventory (metadata, not approval):\n${JSON.stringify(subject, null, 2)}`);
  for (let i = 0; i < subject.members.length; i++) {
    const m = subject.members[i]!;
    terminal.display(`--- FULL ${m.role} (${m.id}, SHA-256 ${m.sha256}) ---\nSource locator (effective ai-usage root): ${m.source}\n${new TextDecoder("utf-8", { fatal: true }).decode(documents[i]!)}\n--- END ${m.id} ---`);
  }
}
/** ONE native foreground decision. Documents are fully available in terminal,
 * default Cancel; no per-page approval, transcript phrase or JSON receipt import.
 * The returned capture is a trusted adapter port, not accepted CLI arguments. */
export async function captureAutoFullReview(review: AutoFullReview, terminal: AutoTerminal): Promise<AutoNativeCapture> {
  terminal.authenticate();
  if (!checkDocumentPackage(review.subject, review.documents).structuralPass || review.subject.members.some(m => !m.mediaType.startsWith("text/"))
    || workflowDigest(JSON.stringify(review.startIntent)) !== review.startSha256) throw new AutoWaitlistError("AUTO_SOURCE");
  terminal.display(`${review.subject.ticket}: full package and finite implementation-start review.\nDocument scope: ${review.documentScope}. Start is a separate finite intent.\nNo push, PR, merge, release, ticket-done, checkout return or human-UAT sign-off.\nSubject SHA-256: ${review.subjectSha256}\nStart SHA-256: ${review.startSha256}`);
  displayAutoFullPackage(terminal, review.subject, review.documents);
  terminal.display(`Exact start bindings (including configured provider/model, finite deadline, branch and checks):\n${JSON.stringify(review.startIntent, null, 2)}`);
  const selected = await terminal.choose("Decide on exactly the full documents and start bindings displayed above. Nothing is approved by default.", [
    review.documentScope === "publish-and-queue" ? "Approve the exact document scope AND separate finite implementation-start intent" : "Approve the finite implementation-start and displayed ticket effects; unchanged content is not reapproved", "Reject this proposal without rejecting the ticket", "Request changes to the proposal",
  ]);
  terminal.authenticate();
  const outcome = (["approved", "rejected", "changes-requested"] as const)[selected] ?? "cancelled";
  const principal = `local-uid:${userInfo().uid}`, interactionId = `interaction-${randomUUID()}`;
  const evidence = Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-native-review/v1", method: "ppa-auto-foreground", principal, interactionId,
    subjectSha256: review.subjectSha256, startSha256: review.startSha256, documentScope: review.documentScope,
    displayedMembers: review.subject.members.map(m => ({ id: m.id, sha256: m.sha256 })), outcome,
    boundary: "native-unmanaged-controlling-terminal-not-hostile-same-uid-isolation" }));
  return { outcome, principal, interactionId, evidenceSha256: workflowDigest(evidence), evidence };
}
