import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertMatchingRuntime, assertSupportedRuntime, getDeployPaths, queryReadonlyDeploymentStatus, readRecordedRuntimeSession } from "@pa-platform/pa-core";

export function readSession(id: string, expected: string): string {
  const dir = getDeployPaths(id).deployDir;
  const recorded = queryReadonlyDeploymentStatus(id, true)?.runtime;
  if (recorded !== undefined) assertMatchingRuntime(recorded, "pi");
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    const match = /^session-id-(.+)\.txt$/.exec(file);
    if (!match) continue;
    assertSupportedRuntime(match[1]);
    assertMatchingRuntime(match[1], "pi");
  }
  const path = resolve(dir, expected);
  if (!existsSync(path)) throw new Error(`no Pi session id recorded for ${id} — cannot resume`);
  const value = readRecordedRuntimeSession(id, expected);
  if (!value) throw new Error(`empty Pi session id recorded for ${id} — cannot resume`);
  return value;
}
