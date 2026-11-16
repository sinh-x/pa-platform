import { appendActivityEvent, createActivityEvent } from "@pa-platform/pa-core";
import { resolve } from "node:path";
import type { PiAgentMessage, PiToolResult } from "./index.js";

/** In-memory marker proving a read result came from the PA source guard. It is
 * implementation custody, not model input: another extension cannot mint it
 * through tool arguments, and a replacement reader loses it. */
export const SOURCE_GUARD_MARKER = "pa-local-read/v1";

export function markSourceGuardResult<T extends PiToolResult>(result: T): T {
  result.details = { ...result.details, sourceGuard: SOURCE_GUARD_MARKER };
  return result;
}

export interface SourceGuardCoverage {
  readonly guarded: number;
  readonly unguarded: number;
}

/** Compare the session transcript with PA's own marker. Any read result without
 * the marker was delivered by a different implementation (another guard, a
 * native reader or a pre-empting plugin), so this session cannot claim PA source
 * policy enforcement. Counting only delivered results avoids false positives from
 * requests that never reached any reader. */
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

/** Durable, bounded attestation. Silent when PA's guarded reader delivered every
 * read; otherwise one activity event records counts only (no source path, query
 * or content). Never fails the session: a reporting error must not manufacture
 * source evidence or block normal settlement. */
export function recordSourceGuardCoverage(messages: readonly PiAgentMessage[], env: NodeJS.ProcessEnv = process.env): SourceGuardCoverage | undefined {
  try {
    const coverage = sourceGuardCoverage(messages);
    if (coverage.guarded + coverage.unguarded === 0 || coverage.unguarded === 0) return coverage;
    const deploymentId = env["PA_DEPLOYMENT_ID"]?.trim();
    if (!deploymentId) return coverage;
    const deploymentDir = env["PA_DEPLOYMENT_DIR"]?.trim();
    const activityLogPath = env["PA_ACTIVITY_LOG"]?.trim() || (deploymentDir ? resolve(deploymentDir, "activity.jsonl") : undefined);
    const body = `Source-policy coverage unverified: ${coverage.unguarded} read result(s) were delivered by a reader outside the PA source guard (${coverage.guarded} guarded). Source classification for those reads is unverified, so this session is not evidence that PA local-source policy was enforced.`;
    const event = createActivityEvent({ deployId: deploymentId, kind: "text", source: "pi", body, metadata: { schema: "pa-source-guard-coverage/v1", guarded: coverage.guarded, unguarded: coverage.unguarded } });
    appendActivityEvent(event, activityLogPath);
    return coverage;
  } catch { return undefined; }
}
