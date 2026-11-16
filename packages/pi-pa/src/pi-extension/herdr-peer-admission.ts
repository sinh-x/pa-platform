/** P3 peer admission predicate — pure, effect-free and not wired to any tool.
 *
 * Peer context is untrusted agent input, never human approval or workflow
 * authority. Before a future request/reply effect may use a Herdr pane, it must
 * establish that the pane is our peer (not us), unambiguous, ready, idle and at
 * the expected PA checkout. This module only decides that; it submits nothing,
 * reads nothing and grants nothing. Submission, consent and reply correlation
 * stay with their own owners. */
export const HERDR_PEER_TARGET = /^w[A-Za-z0-9]{1,32}:p[A-Za-z0-9]{1,32}$/;

/** Fields used from the Herdr `AgentInfo` result (protocol 22). Unknown values
 * are rejected instead of being coerced into an identity claim. */
export interface HerdrPeerAgent {
  readonly pane_id: string;
  readonly agent?: string | null;
  readonly agent_status: string;
  readonly completion_seq?: number | null;
  readonly state_change_seq?: number;
  readonly interactive_ready?: boolean;
  readonly launch_pending?: boolean;
  readonly cwd?: string | null;
  readonly foreground_cwd?: string | null;
  readonly agent_session?: { readonly kind?: unknown; readonly value?: unknown } | null;
}

export type PeerRejection =
  | "invalid-target" | "self" | "unknown" | "ambiguous" | "not-ready"
  | "busy" | "blocked" | "unknown-state" | "identity-mismatch";

export interface PeerAdmission {
  readonly target: string;
  /** Identity/order baseline captured before any submission. `completionSeq`
   * advances when an idle transition completes work; it is the only documented
   * turn-completion signal Herdr exposes, and it is not request-specific. */
  readonly baseline: { readonly completionSeq: number | null; readonly stateChangeSeq: number };
  readonly sessionRef?: string;
}

export type PeerDecision = { readonly ok: true; readonly admission: PeerAdmission } | { readonly ok: false; readonly reason: PeerRejection };

export interface PeerAdmissionInput {
  readonly ownPaneId: string;
  readonly requestedPaneId: string;
  readonly agents: readonly HerdrPeerAgent[];
  /** Exact PA checkout the peer must report, when the caller can bind one. */
  readonly expectedCwd?: string;
}

const absolutePath = (value: unknown): string | undefined =>
  typeof value === "string" && value.startsWith("/") && !value.includes("\u0000") ? value : undefined;

const sessionRef = (agent: HerdrPeerAgent): string | undefined => {
  const session = agent.agent_session;
  if (!session || session.kind !== "path") return undefined;
  return absolutePath(session.value) ? session.value as string : undefined;
};

/** Reject-first ordering: a malformed request never resolves to a different
 * live pane, our own pane is never a peer, and an ambiguous match is refused
 * before any state is read. */
export function admitPeerTarget(input: PeerAdmissionInput): PeerDecision {
  const requested = input.requestedPaneId;
  if (typeof requested !== "string" || !HERDR_PEER_TARGET.test(requested)) return { ok: false, reason: "invalid-target" };
  if (requested === input.ownPaneId) return { ok: false, reason: "self" };
  const matches = input.agents.filter(agent => agent.pane_id === requested);
  if (matches.length === 0) return { ok: false, reason: "unknown" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  const target = matches[0]!;
  if (input.expectedCwd !== undefined) {
    const expected = absolutePath(input.expectedCwd);
    const observed = absolutePath(target.cwd) ?? absolutePath(target.foreground_cwd);
    if (!expected || !observed || observed !== expected) return { ok: false, reason: "identity-mismatch" };
  }
  if (target.launch_pending === true || target.interactive_ready === false) return { ok: false, reason: "not-ready" };
  if (target.agent_status === "working") return { ok: false, reason: "busy" };
  if (target.agent_status === "blocked") return { ok: false, reason: "blocked" };
  if (target.agent_status !== "idle" && target.agent_status !== "done") return { ok: false, reason: "unknown-state" };
  const completionSeq = typeof target.completion_seq === "number" && Number.isSafeInteger(target.completion_seq) && target.completion_seq >= 0
    ? target.completion_seq : null;
  const stateChangeSeq = typeof target.state_change_seq === "number" && Number.isSafeInteger(target.state_change_seq) && target.state_change_seq >= 0
    ? target.state_change_seq : 0;
  const ref = sessionRef(target);
  return { ok: true, admission: { target: requested, baseline: { completionSeq, stateChangeSeq }, ...(ref ? { sessionRef: ref } : {}) } };
}
