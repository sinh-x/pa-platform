import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPeerReply, PEER_BUDGET_MAX_MS, PEER_NONCE, PEER_REPLY_LIMIT_BYTES, PEER_REPLY_LIMIT_LINES,
  PEER_REQUEST_LIMIT_BYTES, planPeerRequest,
} from "../pi-extension/herdr-peer-exchange.js";

const nonce = "[[pa-peer:01234567-89ab-cdef-0123-456789abcdef]]";

test("request planning bounds target, nonce, text and the total wait budget", () => {
  const planned = planPeerRequest({ target: "w1:p3A", body: "Summarise the failing check.", budgetMs: 30_000, nonce });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.plan.prompt.target, "w1:p3A");
  assert.equal(planned.plan.prompt.text, `${nonce}\nSummarise the failing check.`);
  assert.deepEqual(planned.plan.prompt.wait, { until: ["idle", "done", "blocked"], timeout_ms: 30_000 });
  assert.equal(PEER_NONCE.test(nonce), true);
  const reason = (input: Parameters<typeof planPeerRequest>[0]) => {
    const decision = planPeerRequest(input);
    return decision.ok ? "accepted" : decision.reason;
  };
  assert.equal(reason({ target: "w1/p3A", body: "x", budgetMs: 1, nonce }), "invalid-target");
  assert.equal(reason({ target: "w1:p3A", body: "x", budgetMs: 1, nonce: "not-a-nonce" }), "invalid-nonce");
  assert.equal(reason({ target: "w1:p3A", body: "   ", budgetMs: 1, nonce }), "empty-request");
  assert.equal(reason({ target: "w1:p3A", body: "x", budgetMs: 0, nonce }), "invalid-budget");
  assert.equal(reason({ target: "w1:p3A", body: "x", budgetMs: PEER_BUDGET_MAX_MS + 1, nonce }), "invalid-budget");
  assert.equal(reason({ target: "w1:p3A", body: "x", budgetMs: 1.5, nonce }), "invalid-budget");
  assert.equal(reason({ target: "w1:p3A", body: "é".repeat(PEER_REQUEST_LIMIT_BYTES), budgetMs: 1, nonce }), "oversized-request");
});

test("reply attribution needs the nonce, a new completion and a non-blocked settle", () => {
  const base = { text: `analysis\n${nonce}\nlooks fine`, nonce, baselineCompletionSeq: 4, settledCompletionSeq: 5, settledStatus: "idle" };
  assert.deepEqual(classifyPeerReply(base), { status: "correlated", reply: `analysis\n${nonce}\nlooks fine`, truncated: false });
  const uncertain = (overrides: Partial<typeof base>) => {
    const result = classifyPeerReply({ ...base, ...overrides });
    return result.status === "uncertain" ? result.reason : "correlated";
  };
  assert.equal(uncertain({ text: "analysis without the marker" }), "reply-not-attributed");
  assert.equal(uncertain({ nonce: "bad" }), "reply-not-attributed");
  assert.equal(uncertain({ settledStatus: "blocked" }), "peer-blocked");
  assert.equal(uncertain({ settledStatus: "unknown" }), "peer-state-unknown");
  assert.equal(uncertain({ baselineCompletionSeq: null }), "no-completion-baseline");
  assert.equal(uncertain({ settledCompletionSeq: null }), "no-completion-baseline");
  assert.equal(uncertain({ settledCompletionSeq: 4 }), "no-new-completion");
});

test("reply reads are a bounded, ANSI-stripped tail and oversized input is marked", () => {
  const long = Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n");
  const reply = classifyPeerReply({ text: `\u001b[31mred\u001b[0m\n${long}`, nonce, baselineCompletionSeq: 1, settledCompletionSeq: 2, settledStatus: "idle" });
  assert.equal(reply.status, "uncertain", "the nonce line is outside the bounded tail");
  assert.equal(reply.truncated, true);
  assert.equal(reply.reply.split("\n").length, PEER_REPLY_LIMIT_LINES);
  assert.doesNotMatch(reply.reply, /\u001b\[/);
  const huge = classifyPeerReply({ text: `${nonce}\n${"x".repeat(PEER_REPLY_LIMIT_BYTES + 100)}`, nonce, baselineCompletionSeq: 1, settledCompletionSeq: 2, settledStatus: "idle" });
  assert.equal(huge.status, "uncertain", "byte truncation keeps the tail, so a leading marker is lost rather than guessed");
  assert.equal(huge.truncated, true);
  assert.ok(Buffer.byteLength(huge.reply) <= PEER_REPLY_LIMIT_BYTES);
  const tailed = classifyPeerReply({ text: `${"x".repeat(PEER_REPLY_LIMIT_BYTES + 100)}\n${nonce}`, nonce, baselineCompletionSeq: 1, settledCompletionSeq: 2, settledStatus: "idle" });
  assert.equal(tailed.status, "correlated");
  assert.equal(tailed.truncated, true);
  assert.ok(Buffer.byteLength(tailed.reply) <= PEER_REPLY_LIMIT_BYTES);
});
