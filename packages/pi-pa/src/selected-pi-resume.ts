import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { formatBoundedFiveFieldDiagnostic, getDeployPaths, parseReviewEvidenceJson, readReviewEvidenceFile } from "@pa-platform/pa-core";
import { resolveSelectedPiLaunch, type SelectedPiLaunch } from "./selected-pi-launch.js";

const FILE = "pi-selected-host.json";
const headline = "Pi session launch is blocked.\n";
const failure = () => new Error(headline + formatBoundedFiveFieldDiagnostic({
  condition: "the requested session has not started through a verified host contract",
  source: "private deployment-to-host session binding",
  reason: "the check could not establish private evidence matching this deployment, session and build; the exact cause is unproven",
  correction: "ask the runtime owner to inspect this deployment and any original session. Impact: none. Actor: agent or operator. New approval: not required to ask. Prerequisite: preserve deployment, session and launch evidence",
  resumeAction: "continue only after the matching original host contract can be verified; admission runs again. Do not upgrade retained sessions or replace uncertain operations",
}, 2000 - headline.length));
export const selectedPiResumeDiagnostic = (): string => failure().message;
const identity = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function location(id: string, deploymentsDirectory?: string): string {
  if (!identity(id) || deploymentsDirectory !== undefined && !isAbsolute(deploymentsDirectory)) throw failure();
  return join(deploymentsDirectory ? join(deploymentsDirectory, id) : getDeployPaths(id).deployDir, FILE);
}
function read(id: string, deploymentsDirectory?: string): unknown | undefined {
  const path = location(id, deploymentsDirectory);
  let before;
  try { before = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw failure(); }
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.()) throw failure();
    const bytes = readReviewEvidenceFile(path, 16384, "Pi selected host binding");
    const after = lstatSync(path);
    for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"] as const) if (before[key] !== after[key]) throw failure();
    const value = parseReviewEvidenceJson(bytes, "Pi selected host binding");
    if (`${JSON.stringify(value)}\n` !== bytes.toString()) throw failure();
    return value;
  } catch { throw failure(); }
}
function expected(id: string, sessionId: string, selected: SelectedPiLaunch): Record<string, unknown> {
  if (!identity(id) || !identity(sessionId)) throw failure();
  return { schemaVersion: 1, deploymentId: id, sessionId, entryFile: selected.entryFile, nodeFile: selected.nodeFile,
    packageRoot: selected.packageRoot, addonFile: selected.addonFile };
}

/** Pure evidence comparison; this record never authenticates source origin or
 * permits reads. The fixed executing producer must independently prove custody. */
export function matchesSelectedPiResumeRecord(record: unknown, id: string, sessionId: string, selected: SelectedPiLaunch): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const wanted = expected(id, sessionId, selected), fields = Object.getOwnPropertyDescriptors(record);
  return Object.keys(fields).sort().join(",") === Object.keys(wanted).sort().join(",")
    && Object.entries(wanted).every(([key, value]) => fields[key] && "value" in fields[key]! && fields[key]!.value === value);
}

/** Read-only, before allocation in the CLI and rechecked by the actual adapter.
 * Ordinary-to-selected and selected-to-ordinary resumes reject rather than
 * silently upgrading/downgrading a retained session's host contract. */
export function assertSelectedPiResumeHost(id: string, sessionId: string, deploymentsDirectory?: string): void {
  const selected = resolveSelectedPiLaunch(), previous = read(id, deploymentsDirectory);
  if (!selected && previous === undefined) return;
  if (!selected || !matchesSelectedPiResumeRecord(previous, id, sessionId, selected)) throw failure();
}

/** Absent-only private launch observation, not a grant, migration or repair. */
export function recordSelectedPiLaunch(id: string, sessionId: string, selected: SelectedPiLaunch, directory: string): void {
  if (!isAbsolute(directory) || basename(directory) !== id) throw failure();
  const path = location(id, dirname(directory));
  let parent;
  try { parent = lstatSync(directory); } catch { throw failure(); }
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0) throw failure();
  const previous = read(id, dirname(directory));
  if (previous !== undefined) {
    if (!matchesSelectedPiResumeRecord(previous, id, sessionId, selected)) throw failure();
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(expected(id, sessionId, selected))}\n`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { throw failure(); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure(); } }
  if (!matchesSelectedPiResumeRecord(read(id, dirname(directory)), id, sessionId, selected)) throw failure();
}
