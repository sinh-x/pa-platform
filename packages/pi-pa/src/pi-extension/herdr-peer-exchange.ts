/** P3 exchange contract — pure planning and observation helpers, no effect.
 *
 * The Herdr server accepts `agent.prompt`, but its own contract says it "does not
 * track turns", and the audited read channel is raw terminal text. An
 * echoed request can therefore look exactly like a response, so this module never
 * claims that a reply is correlated: the best mechanical outcome is `unverified`.
 * A future framed, identity-bound response channel must add that claim and its
 * own tests. Only bounded measurements are returned, never terminal bodies.
 * Nothing is resent automatically and no terminal input is used. */
export const PEER_REQUEST_LIMIT_BYTES = 4096;
export const PEER_REPLY_LIMIT_BYTES = 16 * 1024;
export const PEER_REPLY_LIMIT_LINES = 80;
export const PEER_BUDGET_MAX_MS = 60_000;
export const PEER_NONCE = /^\[\[pa-peer:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]\](?![\s\S])/;
const TARGET = /^w[A-Za-z0-9]{1,32}:p[A-Za-z0-9]{1,32}(?![\s\S])/;
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface PeerRequestPlan {
  readonly nonce: string;
  readonly text: string;
  readonly prompt: { readonly target: string; readonly text: string; readonly wait: { readonly until: readonly ["idle", "done", "blocked"]; readonly timeout_ms: number } };
}

export type PeerPlanRejection = "invalid-target" | "invalid-nonce" | "empty-request" | "oversized-request" | "invalid-budget";
export type PeerPlan = { readonly ok: true; readonly plan: PeerRequestPlan } | { readonly ok: false; readonly reason: PeerPlanRejection };

/** The nonce in the request text is a correlation aid for a cooperative peer and
 * for log matching. It is not proof of reading or obedience, and an echoed
 * request line can carry it back without the peer having answered. */
export function planPeerRequest(input: { readonly target: string; readonly body: string; readonly budgetMs: number; readonly nonce: string }): PeerPlan {
  if (typeof input.target !== "string" || !TARGET.test(input.target)) return { ok: false, reason: "invalid-target" };
  if (typeof input.nonce !== "string" || !PEER_NONCE.test(input.nonce)) return { ok: false, reason: "invalid-nonce" };
  if (typeof input.body !== "string" || input.body.trim().length === 0) return { ok: false, reason: "empty-request" };
  if (typeof input.budgetMs !== "number" || !Number.isSafeInteger(input.budgetMs) || input.budgetMs <= 0 || input.budgetMs > PEER_BUDGET_MAX_MS) return { ok: false, reason: "invalid-budget" };
  // Preserve the request intact. Count the entire planned JSON parameter
  // envelope, not only the body; a future RPC owner must also budget its framing.
  const text = `${input.nonce}\n${input.body}`;
  const prompt: PeerRequestPlan["prompt"] = {
    target: input.target, text, wait: { until: ["idle", "done", "blocked"], timeout_ms: input.budgetMs },
  };
  if (Buffer.byteLength(JSON.stringify(prompt)) > PEER_REQUEST_LIMIT_BYTES) return { ok: false, reason: "oversized-request" };
  return { ok: true, plan: { nonce: input.nonce, text, prompt } };
}

/** `unverified` means every mechanical observation held; it is not a claim that
 * the peer answered this request. `uncertain` names the failed observation. */
export type PeerReplyStatus = "unverified" | "uncertain";
export type PeerReplyReason =
  | "unframed-channel" | "invalid-text" | "invalid-nonce" | "missing-marker"
  | "peer-working" | "peer-blocked" | "peer-unknown" | "invalid-state"
  | "invalid-counter" | "no-new-completion";
/** Observation metadata only: neither outcome contains a response body or a
 * delivery/authority claim. The input may be unrelated terminal content. */
export interface PeerReply {
  readonly status: PeerReplyStatus;
  readonly reason: PeerReplyReason;
  readonly observed: { readonly bytes: number; readonly lines: number };
  readonly truncated: boolean;
}

const stripCsi = (text: string): string => text.replace(CSI, "");

/** Keep the last `limit` bytes of a UTF-8 buffer without splitting a code point
 * or exceeding the limit after decoding. Re-encoding the result is checked. */
function tailBytes(text: string, limit: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text);
  if (buffer.length <= limit) return { text, truncated: false };
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  let decoded = buffer.subarray(start).toString("utf8");
  while (Buffer.byteLength(decoded) > limit && start < buffer.length) {
    start++;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
    decoded = buffer.subarray(start).toString("utf8");
  }
  return { text: decoded, truncated: true };
}

/** Line cap first, then a code-point-safe byte tail. Oversized input is marked,
 * never delivered as an unbounded read. */
function boundedTail(text: string): { text: string; truncated: boolean } {
  const lines = stripCsi(text).split("\n");
  const selected = lines.slice(-PEER_REPLY_LIMIT_LINES);
  const result = tailBytes(selected.join("\n"), PEER_REPLY_LIMIT_BYTES);
  return { text: result.text, truncated: result.truncated || selected.length < lines.length };
}

const counter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Conservative metadata observation of unframed terminal text. The terminal-state
 * allowlist is exactly the agent states that can end a turn; `working`, `blocked`,
 * `unknown` and any unrecognised value are refused. Counters must be explicit
 * non-negative integers, and the completion counter must strictly advance. */
export function classifyPeerReply(input: {
  readonly text: unknown;
  readonly nonce: unknown;
  readonly baselineCompletionSeq: unknown;
  readonly settledCompletionSeq: unknown;
  readonly settledStatus: unknown;
}): PeerReply {
  const bounded = boundedTail(typeof input.text === "string" ? input.text : "");
  const observation = {
    observed: { bytes: Buffer.byteLength(bounded.text), lines: bounded.text ? bounded.text.split("\n").length : 0 },
    truncated: bounded.truncated,
  };
  const uncertain = (reason: PeerReplyReason): PeerReply => ({ status: "uncertain", reason, ...observation });
  if (typeof input.text !== "string") return uncertain("invalid-text");
  if (typeof input.nonce !== "string" || !PEER_NONCE.test(input.nonce)) return uncertain("invalid-nonce");
  if (input.settledStatus === "working") return uncertain("peer-working");
  if (input.settledStatus === "blocked") return uncertain("peer-blocked");
  if (input.settledStatus === "unknown") return uncertain("peer-unknown");
  if (input.settledStatus !== "idle" && input.settledStatus !== "done") return uncertain("invalid-state");
  const baseline = counter(input.baselineCompletionSeq), settled = counter(input.settledCompletionSeq);
  if (baseline === undefined || settled === undefined) return uncertain("invalid-counter");
  if (settled <= baseline) return uncertain("no-new-completion");
  if (!bounded.text.includes(input.nonce)) return uncertain("missing-marker");
  return { status: "unverified", reason: "unframed-channel", ...observation };
}
