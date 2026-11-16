/** P3 exchange contract — pure planning and attribution helpers, no effect.
 *
 * The Herdr server accepts `agent.prompt`, but its own contract says it "does not
 * track turns". A reply is therefore attributable only when the target was idle
 * at admission, its completion counter advanced after submission, and the reply
 * contains the request nonce. Anything less is reported as uncertain; nothing is
 * resent automatically and no terminal input is used. */
export const PEER_REQUEST_LIMIT_BYTES = 4096;
export const PEER_REPLY_LIMIT_BYTES = 16 * 1024;
export const PEER_REPLY_LIMIT_LINES = 80;
export const PEER_BUDGET_MAX_MS = 60_000;
export const PEER_NONCE = /^\[\[pa-peer:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]\]$/;
const TARGET = /^w[A-Za-z0-9]{1,32}:p[A-Za-z0-9]{1,32}$/;
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface PeerRequestPlan {
  readonly nonce: string;
  readonly text: string;
  readonly prompt: { readonly target: string; readonly text: string; readonly wait: { readonly until: readonly ["idle", "done", "blocked"]; readonly timeout_ms: number } };
}

export type PeerPlanRejection = "invalid-target" | "invalid-nonce" | "empty-request" | "oversized-request" | "invalid-budget";
export type PeerPlan = { readonly ok: true; readonly plan: PeerRequestPlan } | { readonly ok: false; readonly reason: PeerPlanRejection };

/** The nonce is part of the request text so a cooperative peer can echo it; it is
 * a correlation aid, never proof that the peer read or obeyed the request. */
export function planPeerRequest(input: { readonly target: string; readonly body: string; readonly budgetMs: number; readonly nonce: string }): PeerPlan {
  if (typeof input.target !== "string" || !TARGET.test(input.target)) return { ok: false, reason: "invalid-target" };
  if (typeof input.nonce !== "string" || !PEER_NONCE.test(input.nonce)) return { ok: false, reason: "invalid-nonce" };
  if (typeof input.body !== "string" || input.body.trim().length === 0) return { ok: false, reason: "empty-request" };
  if (typeof input.budgetMs !== "number" || !Number.isSafeInteger(input.budgetMs) || input.budgetMs <= 0 || input.budgetMs > PEER_BUDGET_MAX_MS) return { ok: false, reason: "invalid-budget" };
  const text = `${input.nonce}\n${input.body.trim()}`;
  if (Buffer.byteLength(text) > PEER_REQUEST_LIMIT_BYTES) return { ok: false, reason: "oversized-request" };
  return {
    ok: true,
    plan: {
      nonce: input.nonce,
      text,
      prompt: { target: input.target, text, wait: { until: ["idle", "done", "blocked"] as const, timeout_ms: input.budgetMs } },
    },
  };
}

export type PeerReplyStatus = "correlated" | "uncertain";
export type PeerReplyReason = "reply-not-attributed" | "no-completion-baseline" | "no-new-completion" | "peer-blocked" | "peer-state-unknown";
export interface PeerReply {
  readonly status: PeerReplyStatus;
  readonly reason?: PeerReplyReason;
  readonly reply: string;
  readonly truncated: boolean;
}

const stripCsi = (text: string): string => text.replace(CSI, "");

/** Bounded tail: the settle boundary is the end of the terminal, so the last
 * lines are the reply. Oversized input is truncated and marked, never delivered
 * as an unbounded read. */
function boundedTail(text: string): { text: string; truncated: boolean } {
  const lines = stripCsi(text).split("\n");
  let selected = lines.slice(-PEER_REPLY_LIMIT_LINES);
  let truncated = selected.length < lines.length;
  let joined = selected.join("\n");
  while (Buffer.byteLength(joined) > PEER_REPLY_LIMIT_BYTES && selected.length > 1) {
    selected = selected.slice(1);
    joined = selected.join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(joined) > PEER_REPLY_LIMIT_BYTES) {
    joined = Buffer.from(joined).subarray(-PEER_REPLY_LIMIT_BYTES).toString("utf8");
    truncated = true;
  }
  return { text: joined, truncated };
}

/** Attribution is deliberately conservative: any missing fact yields `uncertain`
 * with a typed reason, and uncertain delivery is never retried automatically. */
export function classifyPeerReply(input: {
  readonly text: string;
  readonly nonce: string;
  readonly baselineCompletionSeq: number | null;
  readonly settledCompletionSeq: number | null;
  readonly settledStatus: string;
}): PeerReply {
  const bounded = boundedTail(typeof input.text === "string" ? input.text : "");
  const uncertain = (reason: PeerReplyReason): PeerReply => ({ status: "uncertain", reason, reply: bounded.text, truncated: bounded.truncated });
  if (!PEER_NONCE.test(input.nonce) || !bounded.text.includes(input.nonce)) return uncertain("reply-not-attributed");
  if (input.settledStatus === "blocked") return uncertain("peer-blocked");
  if (input.settledStatus === "unknown") return uncertain("peer-state-unknown");
  if (input.baselineCompletionSeq === null || input.settledCompletionSeq === null) return uncertain("no-completion-baseline");
  if (input.settledCompletionSeq <= input.baselineCompletionSeq) return uncertain("no-new-completion");
  return { status: "correlated", reply: bounded.text, truncated: bounded.truncated };
}
