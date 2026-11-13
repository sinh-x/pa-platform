import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { AutoWaitlistError, assertUnmanagedOperator, workflowDigest, checkDocumentPackage, type DocumentPackage } from "@pa-platform/pa-core";

export interface AutoTerminal {
  authenticate(): void;
  display(text: string): void;
  choose(prompt: string, choices: readonly string[]): Promise<number>;
}
const visible = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** TTY is transport, not identity: the existing unmanaged-origin owner also
 * rejects environment-cleared descendants of managed agents on every read. */
export function nativeAutoTerminal(): AutoTerminal {
  const authenticate = () => {
    assertUnmanagedOperator();
    if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") throw new AutoWaitlistError("AUTO_UNAVAILABLE");
  };
  return { authenticate, display(text) { authenticate(); process.stderr.write(`${visible(text)}\n`); },
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
  startIntent: unknown; startSha256: string; documentScope: "none" | "publish-and-queue";
}
export interface AutoNativeCapture {
  outcome: "approved" | "rejected" | "changes-requested" | "cancelled";
  principal: string; interactionId: string; evidenceSha256: string; evidence: Buffer;
}
/** ONE native foreground decision. Documents are fully available in terminal,
 * default Cancel; no per-page approval, transcript phrase or JSON receipt import.
 * The returned capture is a trusted adapter port, not accepted CLI arguments. */
export async function captureAutoFullReview(review: AutoFullReview, terminal: AutoTerminal): Promise<AutoNativeCapture> {
  terminal.authenticate();
  if (!checkDocumentPackage(review.subject, review.documents).structuralPass || review.subject.members.some(m => !m.mediaType.startsWith("text/"))
    || workflowDigest(JSON.stringify(review.startIntent)) !== review.startSha256) throw new AutoWaitlistError("AUTO_SOURCE");
  terminal.display(`${review.subject.ticket}: full package and finite implementation-start review.\nDocument scope: ${review.documentScope}. Start is a separate finite intent.\nNo push, PR, merge, release, ticket-done, checkout return or human-UAT sign-off.\nSubject SHA-256: ${review.subjectSha256}\nStart SHA-256: ${review.startSha256}`);
  for (let i = 0; i < review.subject.members.length; i++) {
    const m = review.subject.members[i]!;
    terminal.display(`--- FULL ${m.role} (${m.id}, SHA-256 ${m.sha256}) ---\n${new TextDecoder("utf-8", { fatal: true }).decode(review.documents[i]!)}\n--- END ${m.id} ---`);
  }
  terminal.display(`Exact start bindings (including configured provider/model, finite deadline, branch and checks):\n${JSON.stringify(review.startIntent, null, 2)}`);
  const selected = await terminal.choose("Decide on exactly the full documents and start bindings displayed above. Nothing is approved by default.", [
    "Approve the exact document scope AND separate finite implementation-start intent", "Reject this proposal without rejecting the ticket", "Request changes to the proposal",
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
