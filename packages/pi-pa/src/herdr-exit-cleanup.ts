import { resolveHerdrBinding } from "./pi-extension/herdr-lifecycle.js";

export type HerdrChildDeathEvidence = "pty-exit" | "confirmed-process-gone";
export interface HerdrExitCleanupResult {
  readonly status: "unavailable";
  readonly reason: "incarnation-safe-retirement-unsupported";
  readonly deathEvidence: HerdrChildDeathEvidence;
}

/** Fail-closed checkpoint, NOT a teardown transport or registration claim.
 * Protocol 22 cannot atomically retire an exact Pi incarnation: official-source
 * release is ignored and a delayed source/seq clear can remove a replacement.
 * Do not send either operation, even after a readback or with a newer timestamp.
 *
 * Snapshot eligibility from the actual child environment at launch. Disabled,
 * partial, headless (no foreground caller) and unforwarded selected-host bindings
 * stay inert. Only the supervisor's verified child-death paths may complete this
 * checkpoint. No network, retry, timer, stdout or registry-finalization effect is
 * introduced; a future supported retirement contract needs separate review.
 */
export function createHerdrExitCleanup(env: NodeJS.ProcessEnv): {
  afterVerifiedExit(evidence: HerdrChildDeathEvidence): HerdrExitCleanupResult;
} | undefined {
  if (!resolveHerdrBinding(env)) return undefined;
  let result: HerdrExitCleanupResult | undefined;
  return {
    afterVerifiedExit(deathEvidence) {
      return result ??= Object.freeze({
        status: "unavailable", reason: "incarnation-safe-retirement-unsupported", deathEvidence,
      });
    },
  };
}
