import { DocumentPackageError, contentReviewGuidance, contentReviewOutcomeMessage } from "@pa-platform/pa-core";
import { mutatePiContentReview } from "../content-review-native.js";
import type { PiDocumentConfirmationContext } from "../document-confirmation-native.js";

export async function runContentReviewCommand(args: string, context: PiDocumentConfirmationContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const value = args.trim();
    if (!value) {
      context.ui?.notify?.("No review was selected. Use /pa-review TICKET to list exact references, then /pa-review REFERENCE to sign only. A ticket never chooses a revision.", "info");
      return { status: "not-selected" };
    }
    const discovery = /^[A-Z][A-Z0-9]*-\d+$/.test(value);
    const result = await mutatePiContentReview(JSON.stringify({ schemaVersion: "pa-content-review/v1", action: discovery ? "list" : "review", ...(discovery ? { ticket: value } : { reference: value }) }), context, signal);
    if (discovery) {
      const reviews = result.reviews;
      const references = Array.isArray(reviews) ? reviews.flatMap((review: unknown) => {
        if (!review || typeof review !== "object" || !("reference" in review) || typeof review.reference !== "string" || !/^review:[a-f0-9]{64}$/.test(review.reference)) return [];
        return [review.reference];
      }) : [];
      context.ui?.notify?.(references.length ? `Exact sign-only references for ${value}:\n${references.slice(0, 10).join("\n")}\nCopy one into /pa-review REFERENCE. No revision was selected.${references.length > 10 ? " More references are available through review-list." : ""}`
        : "No eligible sign-only reference was found. Ask the original document owner to verify and prepare the exact immutable delivery. No review target was guessed.", "info");
    } else {
      context.ui?.notify?.(contentReviewOutcomeMessage(result), "info");
    }
    return result;
  } catch (error) {
    const code = error instanceof DocumentPackageError ? error.code : "DOCUMENT_UNAVAILABLE";
    context.ui?.notify?.(contentReviewGuidance(code), "error");
    return { ok: false, code };
  }
}
