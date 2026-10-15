import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { classifyOutputTarget } from "../safety-policy.js";
import { type ArtifactAnchor, type ArtifactIdentity, openArtifactDirectory } from "./manifest.js";
import { artifactDiagnostic, assertArtifactAbsolutePath } from "./policy.js";
import { jsonBytes, opaqueId, readPrivate, replacePrivate, REVIEW_JOURNAL_BYTES, REVIEW_JOURNAL_EVENTS } from "./runtime.js";

export type FeedbackTarget = { type: "document" } | { type: "anchor"; anchor: string; startLine: number; endLine: number };
export interface FeedbackEvent {
  schema: "pa-artifact-feedback/v1"; eventId: string; sessionId: string;
  sourceRef: string; sourceSha256: string; htmlSha256: string;
  target: FeedbackTarget; selectedText: string; feedbackText: string; sequence: number;
}
export interface FeedbackBinding { sessionId: string; identity: ArtifactIdentity; anchors: ArtifactAnchor[] }
export interface FeedbackReconciliation {
  eventId: string; sourceSha256: string; disposition: "accepted" | "rejected" | "deferred";
  rationale: string; affectedRequirements: string[]; renewedApprovalNeeded: boolean;
}
const deny = (): never => { throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED"); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return deny();
  return value as Record<string, unknown>;
}
function target(value: unknown, anchors: ArtifactAnchor[]): FeedbackTarget {
  const v = record(value);
  if (v["type"] === "document" && Object.keys(v).length === 1) return { type: "document" };
  if (v["type"] === "anchor" && Object.keys(v).length === 4) {
    const anchor = anchors.find((a) => a.id === v["anchor"] && a.startLine === v["startLine"] && a.endLine === v["endLine"]);
    if (anchor) return { type: "anchor", anchor: anchor.id, startLine: anchor.startLine, endLine: anchor.endLine };
  }
  return deny();
}
function normalized(value: unknown, binding: FeedbackBinding, sequence: number, journal: boolean): FeedbackEvent {
  const v = record(value);
  if (Object.keys(v).length !== (journal ? 10 : 9) || v["schema"] !== "pa-artifact-feedback/v1"
      || typeof v["eventId"] !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(v["eventId"])
      || v["sessionId"] !== binding.sessionId || v["sourceRef"] !== binding.identity.sourceRef
      || v["sourceSha256"] !== binding.identity.sourceSha256 || v["htmlSha256"] !== binding.identity.htmlSha256
      || typeof v["selectedText"] !== "string" || typeof v["feedbackText"] !== "string"
      || !v["feedbackText"].trim() || Buffer.byteLength(v["feedbackText"]) > 65_536
      || Buffer.byteLength(v["selectedText"]) > 16_384
      || [v["feedbackText"], v["selectedText"]].some(text =>
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))
      || journal && v["sequence"] !== sequence) return deny();
  return {
    schema: "pa-artifact-feedback/v1", eventId: v["eventId"], sessionId: binding.sessionId,
    sourceRef: binding.identity.sourceRef, sourceSha256: binding.identity.sourceSha256, htmlSha256: binding.identity.htmlSha256,
    target: target(v["target"], binding.anchors), selectedText: v["selectedText"], feedbackText: v["feedbackText"], sequence,
  };
}
export function readJournal(fd: number, binding: FeedbackBinding): FeedbackEvent[] {
  try {
    const bytes = readPrivate(fd, "journal.json");
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(parsed) || parsed.length > REVIEW_JOURNAL_EVENTS) return deny();
    const events = parsed.map((value: unknown, index: number) => normalized(value, binding, index + 1, true));
    if (new Set(events.map((event) => event.eventId)).size !== events.length || !jsonBytes(events).equals(bytes)) return deny();
    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** One supervisor serializes writers. Validate entire batch before publishing a
 * complete fsynced journal. ACK/queue consumption MUST occur only after return. */
export function appendFeedback(fd: number, binding: FeedbackBinding, batch: unknown, afterDurable?: () => void): FeedbackEvent[] {
  if (!Array.isArray(batch) || !batch.length || batch.length > REVIEW_JOURNAL_EVENTS) return deny();
  const events = readJournal(fd, binding);
  const known = new Map(events.map((event) => [event.eventId, event]));
  const accepted: FeedbackEvent[] = [];
  for (const raw of batch as unknown[]) {
    const v = record(raw);
    const prior = typeof v["eventId"] === "string" ? known.get(v["eventId"]) : undefined;
    const event = normalized(raw, binding, prior?.sequence ?? events.length + 1, false);
    if (prior) {
      if (!jsonBytes(prior).equals(jsonBytes(event))) return deny();
      accepted.push(prior);
    } else {
      known.set(event.eventId, event); events.push(event); accepted.push(event);
    }
  }
  const bytes = jsonBytes(events);
  if (events.length > REVIEW_JOURNAL_EVENTS || bytes.length > REVIEW_JOURNAL_BYTES) return deny();
  replacePrivate(fd, "journal.json", bytes);
  afterDurable?.();
  return accepted;
}

function identicalExport(parent: number, name: string, expected: Buffer): boolean {
  let file: number | undefined;
  try {
    file = openSync(`/proc/self/fd/${parent}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(file, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(expected.length) || before.uid !== BigInt(process.getuid?.() ?? -1)
        || (before.mode & 0o777n) !== 0o600n) throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
    // A crash between no-clobber link and temp unlink may leave nlink=2. We
    // never modify existing output, only compare exact bounded complete bytes.
    const bytes = Buffer.alloc(expected.length + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(file, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(file, { bigint: true });
    if (length !== expected.length || !bytes.subarray(0, length).equals(expected)
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
  } finally { if (file !== undefined) closeSync(file); }
}

/** Complete no-clobber publication. Byte-identical retries do not rewrite. */
export function exportFeedback(fd: number, binding: FeedbackBinding, output: string): { status: "exported" | "no-feedback"; eventCount: number } {
  assertArtifactAbsolutePath(output);
  if (!classifyOutputTarget(output).allowed) throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
  const events = readJournal(fd, binding);
  if (!events.length) return { status: "no-feedback", eventCount: 0 };
  const bytes = jsonBytes({ schema: "pa-artifact-feedback-export/v1", sessionId: binding.sessionId, events });
  const parent = openArtifactDirectory(dirname(output), "ARTIFACT_OUTPUT_CONFLICT");
  const name = basename(output);
  const temp = `.artifact-feedback-${opaqueId()}`;
  const path = `/proc/self/fd/${parent}/${temp}`;
  let file: number | undefined;
  try {
    if (identicalExport(parent, name, bytes)) return { status: "exported", eventCount: events.length };
    file = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(file, bytes); fsyncSync(file); closeSync(file); file = undefined;
    try { linkSync(path, `/proc/self/fd/${parent}/${name}`); }
    catch {
      if (!identicalExport(parent, name, bytes)) throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
    }
    unlinkSync(path); fsyncSync(parent);
    return { status: "exported", eventCount: events.length };
  } catch { throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT"); }
  finally {
    if (file !== undefined) closeSync(file);
    try { unlinkSync(path); } catch { /* own unpublished temp only */ }
    closeSync(parent);
  }
}
