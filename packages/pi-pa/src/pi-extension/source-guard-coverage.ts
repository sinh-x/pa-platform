import { appendActivityEvent, createActivityEvent } from "@pa-platform/pa-core";
import { resolve } from "node:path";
import type { PiAgentMessage, PiToolResult } from "./index.js";

/** Observable result label, NOT authenticated custody. Foreign extensions or
 * copied results can reproduce this public string. It is never a source grant,
 * an admission decision or evidence of final-delivery enforcement. */
export const SOURCE_GUARD_MARKER = "pa-local-read/v1";

export function markSourceGuardResult<T extends PiToolResult>(result: T): T {
  result.details = { ...result.details, sourceGuard: SOURCE_GUARD_MARKER };
  return result;
}

export interface SourceGuardCoverage {
  readonly guarded: number;
  readonly unguarded: number;
}

/** Count observed labels on delivered read results. Legacy guarded/unguarded
 * field names mean marked/unmarked, not verified reader identity: a missing
 * marker may be a foreign reader or lost metadata; a present one may be copied.
 * Neither the counts nor silence establish admission/publication enforcement. */
export function sourceGuardCoverage(messages: readonly PiAgentMessage[]): SourceGuardCoverage {
  let guarded = 0, unguarded = 0;
  for (const message of messages) {
    const record = message as { role?: string; toolName?: string; details?: unknown };
    if (record.role !== "toolResult" || record.toolName !== "read") continue;
    const details = record.details;
    const marker = details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)["sourceGuard"] : undefined;
    if (marker === SOURCE_GUARD_MARKER) guarded++;
    else unguarded++;
  }
  return { guarded, unguarded };
}

/** Bounded informational observation, not an attestation. When an unmarked read
 * is seen, record counts only (no source path/query/content). All-marked results
 * remain silent, not verified. Reporting cannot grant access or block settlement. */
export function recordSourceGuardCoverage(messages: readonly PiAgentMessage[], env: NodeJS.ProcessEnv = process.env): SourceGuardCoverage | undefined {
  try {
    const coverage = sourceGuardCoverage(messages);
    if (coverage.guarded + coverage.unguarded === 0 || coverage.unguarded === 0) return coverage;
    const deploymentId = env["PA_DEPLOYMENT_ID"]?.trim();
    if (!deploymentId) return coverage;
    const deploymentDir = env["PA_DEPLOYMENT_DIR"]?.trim();
    const activityLogPath = env["PA_ACTIVITY_LOG"]?.trim() || (deploymentDir ? resolve(deploymentDir, "activity.jsonl") : undefined);
    const body = `Source-policy coverage unverified: ${coverage.unguarded} read result(s) lacked the PA source-guard marker (${coverage.guarded} marked). Markers and counts do not authenticate the reader or prove source admission and final-delivery enforcement. Inspect this session's registered reader and publication owner before making an enforcement claim.`;
    const event = createActivityEvent({ deployId: deploymentId, kind: "text", source: "pi", body, metadata: { schema: "pa-source-guard-coverage/v1", guarded: coverage.guarded, unguarded: coverage.unguarded } });
    appendActivityEvent(event, activityLogPath);
    return coverage;
  } catch { return undefined; }
}
