/** Preliminary P3 target observation — pure and not wired to any tool.
 *
 * Herdr facts are untrusted observations, not authenticated PA identity or send
 * admission. Even a successful observation leaves send admission unavailable:
 * deployment/incarnation/read-only authority, consent and atomic native-dialog
 * checks require a separately proven owner. This module submits and grants
 * nothing; cwd and session paths never establish authority. */
export const HERDR_PEER_TARGET = /^w[A-Za-z0-9]{1,32}:p[A-Za-z0-9]{1,32}(?![\s\S])/;

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
  | "invalid-target" | "invalid-self" | "self" | "unknown" | "ambiguous" | "not-ready"
  | "busy" | "blocked" | "unknown-state" | "identity-mismatch" | "unknown-baseline" | "unknown-session";

export interface PeerTargetObservation {
  readonly target: string;
  readonly sendAdmission: "unavailable";
  /** Observed ordering only, not a request-specific completion or identity. */
  readonly baseline: { readonly completionSeq: number; readonly stateChangeSeq: number };
  readonly sessionRef: string;
}

export type PeerObservationDecision = { readonly ok: true; readonly observation: PeerTargetObservation } | { readonly ok: false; readonly reason: PeerRejection };

export interface PeerObservationInput {
  readonly ownPaneId: string;
  readonly requestedPaneId: string;
  readonly agents: readonly HerdrPeerAgent[];
  /** Optional observed checkout match; not authenticated deployment binding. */
  readonly expectedCwd?: string;
}

const absolutePath = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 4096 && value.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const sessionRef = (agent: HerdrPeerAgent): string | undefined => {
  const session = agent.agent_session;
  if (!session || session.kind !== "path") return undefined;
  const path = absolutePath(session.value);
  return path && path.length <= 1024 ? path : undefined;
};

/** Reject-first ordering: a malformed request never resolves to a different
 * live pane, our own pane is never a peer, and an ambiguous match is refused
 * before any state is read. */
export function observePeerTarget(input: PeerObservationInput): PeerObservationDecision {
  const requested = input.requestedPaneId;
  if (typeof requested !== "string" || !HERDR_PEER_TARGET.test(requested)) return { ok: false, reason: "invalid-target" };
  if (typeof input.ownPaneId !== "string" || !HERDR_PEER_TARGET.test(input.ownPaneId)) return { ok: false, reason: "invalid-self" };
  if (requested === input.ownPaneId) return { ok: false, reason: "self" };
  const matches = input.agents.filter(agent => agent != null && agent.pane_id === requested);
  if (matches.length === 0) return { ok: false, reason: "unknown" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  const target = matches[0]!;
  if (input.expectedCwd !== undefined) {
    const expected = absolutePath(input.expectedCwd);
    const observed = absolutePath(target.cwd) ?? absolutePath(target.foreground_cwd);
    if (!expected || !observed || observed !== expected) return { ok: false, reason: "identity-mismatch" };
  }
  if (target.launch_pending !== false || target.interactive_ready !== true) return { ok: false, reason: "not-ready" };
  if (target.agent_status === "working") return { ok: false, reason: "busy" };
  if (target.agent_status === "blocked") return { ok: false, reason: "blocked" };
  if (target.agent_status !== "idle" && target.agent_status !== "done") return { ok: false, reason: "unknown-state" };
  if (!counter(target.completion_seq) || !counter(target.state_change_seq)) return { ok: false, reason: "unknown-baseline" };
  const ref = sessionRef(target);
  if (!ref) return { ok: false, reason: "unknown-session" };
  return { ok: true, observation: {
    target: requested, sendAdmission: "unavailable",
    baseline: { completionSeq: target.completion_seq, stateChangeSeq: target.state_change_seq }, sessionRef: ref,
  } };
}
