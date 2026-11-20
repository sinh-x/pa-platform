import { createInterface } from "node:readline";
import { contentReviewGuidance } from "@pa-platform/pa-core";
import { executeCoreContentReview, localReviewDeadline, localReviewFailure, LOCAL_REVIEW_OVERALL_MS, LocalReviewTransportError,
  serializeLocalReview, type LocalReviewCliIO, type LocalReviewHandler } from "./local-review-cli.js";

const safe = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "\ufffd");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalReviewTransportError("internal");
  return Object.fromEntries(Object.entries(value));
}
function promptTerminal(signal: AbortSignal): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new LocalReviewTransportError("input");
  return new Promise(resolve => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let finished = false;
    const finish = (value?: string) => {
      if (finished) return; finished = true;
      signal.removeEventListener("abort", detached); terminal.close(); resolve(value);
    };
    const detached = () => finish();
    terminal.once("line", line => finish(line)); terminal.once("close", () => finish()); terminal.once("SIGINT", detached);
    signal.addEventListener("abort", detached, { once: true }); if (signal.aborted) detached();
  });
}
function outcomeMessage(result: Record<string, unknown>): string {
  return result.outcome === "approved" ? "Approved · Not published. The exact content decision is saved; no downstream action was authorized or started. No further signing action is required."
    : result.outcome === "changes-requested" ? "Changes requested · Not published. The document owner must prepare a revised candidate; this decision is retained."
    : result.outcome === "rejected" ? "Rejected · Not published. The exact decision is saved."
    : result.outcome === "cancelled" ? "Review cancelled · Not published. This deliberate Cancel is the shared saved outcome."
    : "Review detached. The shared request remains pending; reopen the same reference to continue.";
}
/** Human transport only. The native owner derives all request coordinates and
 * canonical decisions. Legacy stdin/HTTP contracts are unchanged. */
export async function runGuidedContentReview(args: string[], io: LocalReviewCliIO,
  options: { contentHandler?: LocalReviewHandler; prompt?: (signal: AbortSignal) => Promise<string | undefined> } = {}): Promise<number> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  const call = async (action: string, coordinates: Record<string, unknown>) => {
    const result = await localReviewDeadline((options.contentHandler ?? executeCoreContentReview)(JSON.stringify({ schemaVersion: "pa-content-review/v1", action, ...coordinates })), LOCAL_REVIEW_OVERALL_MS);
    serializeLocalReview(result); // Response byte bound applies to injected clients too.
    if (result.ok === false) throw new LocalReviewTransportError("internal");
    return result;
  };
  try {
    if (args.length === 2 && args[0] === "list" && /^[A-Z][A-Z0-9]*-\d+$/.test(args[1]!)) {
      const result = await call("list", { ticket: args[1] }), reviews = result.reviews;
      if (!Array.isArray(reviews)) throw new LocalReviewTransportError("internal");
      const lines = reviews.map((entry: unknown) => {
        const review = record(entry);
        if (typeof review.reference !== "string" || !/^review:[a-f0-9]{64}$/.test(review.reference)
          || typeof review.packageId !== "string" || typeof review.revision !== "number") throw new LocalReviewTransportError("internal");
        return `${safe(review.packageId)} · revision ${review.revision} · Sign only\n${review.reference}`;
      });
      await io.stdout(lines.length ? `Eligible exact reviews for ${args[1]}:\n${lines.join("\n\n")}\nNext: ppa document review REFERENCE (copy one reference above). No revision was selected.`
        : "No eligible sign-only review reference was found. Ask the original document owner to verify and prepare the exact immutable delivery. No target was guessed.");
      return 0;
    }
    const reference = args.length === 1 ? args[0] : args.length === 2 && args[0] === "show" ? args[1] : undefined;
    if (!reference || !/^review:[a-f0-9]{64}$/.test(reference)) throw new LocalReviewTransportError("arguments");
    if (args.length === 1) {
      const pending = await call("request", { reference });
      if (typeof pending.outcome === "string") { await io.stdout(outcomeMessage(pending)); return 0; }
    }
    const view = await call("show", { reference }), document = record(view.document);
    if (!Array.isArray(view.documents)) throw new LocalReviewTransportError("internal");
    await io.stdout(`${safe(String(document.ticket))} · ${safe(String(document.packageId))} · revision ${safe(String(document.revision))} · Sign only\nLocal confirmation; human identity not verified.\nSigning saves exact decision/history only. It grants and invokes no publication, ref/branch/link, queue/status, resources or launch.\nReference: ${reference}`);
    for (const value of view.documents) {
      const member = record(value);
      if (typeof member.id !== "string" || member.content !== null && typeof member.content !== "string") throw new LocalReviewTransportError("internal");
      await io.stdout(`\n--- ${safe(member.id)} ---\n${typeof member.content === "string" ? safe(member.content) : "Opaque image; automatic viewing is not claimed. Use the exact reader/raw delivery."}`);
    }
    await io.stdout(`\nFull reader, standalone members, raw and manifest:\n${safe(JSON.stringify(view.presentation, null, 2))}`);
    if (args[0] === "show") { await io.stdout(`Review status: ${safe(String(view.approval))}. ${view.actionable === true ? "Use ppa document review REFERENCE to decide." : "No actionable signing is available from this view; saved decisions remain in history."}`); return 0; }
    if (view.actionable !== true) throw new LocalReviewTransportError("unavailable");
    await io.stdout("Choose: [a] Approve exact content / [c] Request changes / [r] Reject / [Enter] Cancel (default).\nOnly deliberate Cancel records cancellation. Disconnect/Ctrl-C detaches and leaves pending.");
    let polling = false;
    const external = new Promise<Record<string, unknown>>((resolve, reject) => {
      timer = setInterval(() => {
        if (polling) return; polling = true;
        void call("request", { reference }).then(result => { if (typeof result.outcome === "string") resolve(result); }, reject).finally(() => { polling = false; });
      }, 500);
    });
    const input = async () => {
      const answer = await (options.prompt ?? promptTerminal)(controller.signal);
      // Observe a concurrent decision before accepting local input or detach.
      const latest = await call("request", { reference }); if (typeof latest.outcome === "string") return latest;
      if (answer === undefined) return latest;
      const choice = answer.trim().toLowerCase();
      const outcome = choice === "a" ? "approved" : choice === "c" ? "changes-requested" : choice === "r" ? "rejected" : choice === "" || choice === "cancel" ? "cancelled" : undefined;
      if (!outcome) throw new LocalReviewTransportError("input");
      try { return await call("decide", { reference, outcome }); }
      catch (error) { const recorded = await call("request", { reference }); if (typeof recorded.outcome === "string") return recorded; throw error; }
    };
    const result = await Promise.race([input(), external]);
    await io.stdout(outcomeMessage(result)); return 0;
  } catch (error) {
    // No raw exceptions, protected text or guessed owner causes enter guidance.
    try { await io.stderr(contentReviewGuidance(localReviewFailure(error).code)); } catch { /* Broken output cannot be safely replaced with a second reply. */ }
    return 1;
  } finally { if (timer) clearInterval(timer); controller.abort(); }
}
