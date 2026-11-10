export const WEB_LIMITS = Object.freeze({ urlBytes: 4096, redirects: 5, timeoutMs: 30000, bodyBytes: 2 * 1024 * 1024, textPoints: 16000, replyBytes: 50 * 1024, lines: 2000, concurrent: 2 });
export type PublicWebCode = "WEB_POLICY" | "WEB_INPUT" | "WEB_TARGET" | "WEB_SENSITIVE" | "WEB_UNSUPPORTED" | "WEB_LIMIT" | "WEB_NETWORK" | "WEB_HTTP" | "WEB_CANCELLED" | "WEB_TIMEOUT" | "WEB_BUSY" | "WEB_CLEANUP";
export type PublicWebStage = "not-started" | "resolving" | "requested";
export class PublicWebError extends Error {
  constructor(readonly code: PublicWebCode) { super(code); }
}
/** Fixed typed facts only: no raw URL, page, exception, credential or formatter effects. */
export function publicWebDiagnostic(code: PublicWebCode, stage: PublicWebStage): string {
  const reasons: Record<PublicWebCode, string> = {
    WEB_POLICY: "The native sensitive-content policy could not be loaded; no network request is allowed.",
    WEB_INPUT: "The supplied URL or request is outside the supported public HTTPS input contract.",
    WEB_TARGET: "A destination, DNS answer, redirect or TLS peer is outside the public-network safety boundary.",
    WEB_SENSITIVE: "The native sensitive-content policy rejected input or output; protected content is not returned.",
    WEB_UNSUPPORTED: "This resource is not supported static HTML/UTF-8 text, or appears to require scripts or access controls.",
    WEB_LIMIT: "A URL, redirect, body or resource limit was reached; no complete page text is returned.",
    WEB_NETWORK: "The bounded network operation failed; no page facts can be inferred from this result.",
    WEB_HTTP: "The server did not return a supported complete successful response; its body is not used as page evidence.",
    WEB_CANCELLED: "The caller cancelled this read; no complete page text is returned.",
    WEB_TIMEOUT: "The end-to-end deadline expired; no complete page text is returned.",
    WEB_BUSY: "Two reads already own this session's reader capacity; no additional request was started.",
    WEB_CLEANUP: "Owned network cleanup is unproven; further reads in this session are blocked to avoid duplicate effects.",
  };
  const began = stage === "not-started" ? "not started" : "incomplete";
  return `Page read ${began}: no usable complete result is available.\nCondition: Retrieval is ${began}; ${stage === "requested" ? "a public request may have reached a server" : "no page request was sent"}.\nSource: Native public-page reader (${code}).\nReason: ${reasons[code]}\nCorrection: Inspect the supplied source and this operation with the runtime owner. Impact: read-only. Actor: agent or operator. New approval: not required for inspection; changes retain their owner. Prerequisite: preserve the operation evidence and do not bypass access controls.\nResume Action: Only after the cause is corrected and owned work is settled, request a supported supplied page; admission is checked again. No automatic retry was made.`;
}
export interface PublicWebResponse { status: number; headers: Record<string, string | undefined>; body: Buffer; compressedBytes: number }
export interface PublicWebSuccess {
  schemaVersion: "pa-public-web-result/v1"; ok: true; requestedUrl: string; finalUrl: string; retrievedAt: string;
  title?: string; text: string; evidence: string; bodySha256: string; textSha256: string;
  digestCoverage: "bodySha256=complete-decoded-response-bytes;textSha256=returned-text-UTF8";
  coverage: { kind: "static-text-not-rendered"; clipped: boolean; extractedCodePoints: number; returnedCodePoints: number; decodedBytes: number; compressedBytes: number; redirects: number };
  message: string; cleanup: "settled";
}
export interface PublicWebFailure { schemaVersion: "pa-public-web-result/v1"; ok: false; code: PublicWebCode; stage: PublicWebStage; message: string; cleanup: "settled" | "unknown" }
export type PublicWebResult = PublicWebSuccess | PublicWebFailure;
export function publicWebFailure(code: PublicWebCode, stage: PublicWebStage): PublicWebFailure {
  return { schemaVersion: "pa-public-web-result/v1", ok: false, code, stage, message: publicWebDiagnostic(code, stage), cleanup: code === "WEB_CLEANUP" ? "unknown" : "settled" };
}
