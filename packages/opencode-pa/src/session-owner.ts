import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertMatchingRuntime, assertSupportedRuntime, getDeployPaths, queryReadonlyDeploymentStatus, readRecordedRuntimeSession } from "@pa-platform/pa-core";

export function readPriorSession(deploymentId: string, sessionFileName: string): string {
  const deployDir = getDeployPaths(deploymentId).deployDir;
  const recorded = queryReadonlyDeploymentStatus(deploymentId, true)?.runtime;
  if (recorded !== undefined) assertMatchingRuntime(recorded, "opencode");
  // Session filenames are historical metadata, not an executable runtime map.
  for (const file of existsSync(deployDir) ? readdirSync(deployDir) : []) {
    const match = /^session-id-(.+)\.txt$/.exec(file);
    if (!match) continue;
    assertSupportedRuntime(match[1]);
    assertMatchingRuntime(match[1], "opencode");
  }
  const sessionPath = resolve(deployDir, sessionFileName);
  if (!existsSync(sessionPath)) throw new Error(`no opencode session id recorded for ${deploymentId} — cannot resume (foreground TUI runs are not resumable)`);
  const value = readRecordedRuntimeSession(deploymentId, sessionFileName);
  if (!value) throw new Error(`empty opencode session id recorded for ${deploymentId} — cannot resume`);
  return value;
}
