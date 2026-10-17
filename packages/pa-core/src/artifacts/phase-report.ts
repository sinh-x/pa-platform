import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openArtifactDirectory, readArtifactFileAt } from "./manifest.js";
import { ARTIFACT_READING_RENDERER_VERSION, renderReadingMarkdown } from "./render.js";
import { parseSourceVersion, workflowDigest, workflowError, workflowObject, workflowPath, workflowSha, workflowSynchronous, workflowText, workflowTimestamp, WORKFLOW_OUTPUT_LIMITS, type SourceVersion } from "../deploy/prepared-workflow.js";

export const PHASE_REPORT_VERSION = "phase-report/v1";
export const PHASE_REPORT_SECTIONS = ["summary", "changes", "traceability", "unproven", "gitInventory", "diff", "failures", "custody", "risks", "nextAction", "owner", "learning", "reconstruction", "omissions", "rebaseMapping"] as const;
export interface PhaseReportIdentity {
  readonly date: string;
  readonly team: "builder" | "rogue-one";
  readonly ticket: string | null;
  readonly deploymentId: string;
  readonly phaseId: string;
  readonly attempt: number;
  readonly executor: "implement" | "orchestrator-direct" | "rogue-one";
}
export interface PhaseReportCheck {
  readonly command: string;
  readonly candidateSha: string | null;
  readonly state: "passed" | "failed" | "not-run" | "unknown";
  readonly exitCode: number | null;
  readonly output: SourceVersion | null;
}
export interface PhaseReport {
  readonly schemaVersion: typeof PHASE_REPORT_VERSION;
  readonly identity: PhaseReportIdentity;
  readonly outcome: "success" | "partial" | "failed" | "interrupted";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly baseSha: string | null;
  readonly candidateSha: string | null;
  readonly commitState: "committed" | "no-commit" | "unknown";
  readonly sections: Readonly<Record<typeof PHASE_REPORT_SECTIONS[number], string>>;
  readonly checks: readonly PhaseReportCheck[];
  readonly previousAttempts: readonly SourceVersion[];
  /** Native canonical input: authentication/provenance is resolved by the host, not parsed from prose. */
  readonly evidence: SourceVersion;
}
export interface PhaseReportReceipt {
  readonly schemaVersion: "phase-report-receipt/v1";
  readonly identity: PhaseReportIdentity;
  readonly reportId: string;
  readonly outcome: PhaseReport["outcome"];
  readonly sourceSha256: string;
  readonly htmlSha256: string;
}
export interface PhaseReportDelivery {
  readonly application: "browser" | "obsidian";
  readonly kind: "native-operator" | "labelled-manual";
  readonly reportId: string;
  readonly sourceSha256: string;
  readonly htmlSha256: string;
  readonly observedAt: string;
  readonly evidence: SourceVersion;
}
export interface PhaseReportHost {
  /** Narrow native team-artifact authority; does not grant arbitrary output roots or builder admission. */
  authorize(action: "publish" | "settle", identity: PhaseReportIdentity): void;
  /** Check full Git inventory (both rename endpoints), original failures, exact commands/results and reconstruction origins. */
  verifyReport(report: PhaseReport): void;
  /** Redact private/unrelated/secret content BEFORE public persistence. Must be deterministic. */
  sanitize(markdown: string): string;
  /** Existing sensitive-pattern checks plus native private-value inventory; never a model-provided allow flag. */
  assertPublic(bytes: Buffer): void;
  /** Revalidate native check/Git/candidate evidence at dependent-work settlement. */
  verifyCanonical(receipt: PhaseReportReceipt): void;
  /** Existing owner report's lock/CAS/idempotent index operation, not another workflow database. */
  index(receipt: PhaseReportReceipt): void;
  resolveDelivery(source: SourceVersion): PhaseReportDelivery;
  loadDeliverySources(receipt: PhaseReportReceipt): readonly SourceVersion[];
  /** Durable CAS publication in the existing owner report; helpers below retain the original observation. */
  recordDelivery(receipt: PhaseReportReceipt, delivery: PhaseReportDelivery): void;
}
function native<T>(run: () => T): T { return workflowSynchronous(run()); }
function assertNative(run: () => void): void { if (native(run) !== undefined) throw workflowError(); }
function text(value: unknown, max = 65_536): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || /[\u0000\u0008\u000b\u000c\u001b\u007f]/.test(value)) throw workflowError();
  return value;
}
function nullableSha(value: unknown): string | null { return value === null ? null : workflowSha(value, 40); }
function parseIdentity(value: unknown): PhaseReportIdentity {
  const row = workflowObject(value, ["date", "team", "ticket", "deploymentId", "phaseId", "attempt", "executor"]);
  const date = workflowText(row.date); const deploymentId = workflowText(row.deploymentId); const phaseId = workflowText(row.phaseId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date
    || !/^d-[0-9a-f]{6}$/.test(deploymentId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(phaseId)
    || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1 || Number(row.attempt) > 32
    || (row.team !== "builder" && row.team !== "rogue-one")
    || (row.executor !== "implement" && row.executor !== "orchestrator-direct" && row.executor !== "rogue-one")
    || (row.team === "rogue-one") !== (row.executor === "rogue-one")) throw workflowError();
  const ticket = row.ticket === null ? null : workflowText(row.ticket);
  if (ticket !== null && !/^[A-Z][A-Z0-9]*-\d+$/.test(ticket) || row.team === "builder" && ticket === null) throw workflowError();
  return Object.freeze({ date, team: row.team, ticket, deploymentId, phaseId, attempt: Number(row.attempt), executor: row.executor });
}
export function phaseReportIdentity(value: PhaseReportIdentity): string { return workflowDigest(JSON.stringify(parseIdentity(value))); }
export function parsePhaseReport(value: unknown): PhaseReport {
  const row = workflowObject(value, ["schemaVersion", "identity", "outcome", "startedAt", "finishedAt", "baseSha", "candidateSha", "commitState", "sections", "checks", "previousAttempts", "evidence"]);
  if (row.schemaVersion !== PHASE_REPORT_VERSION || !["success", "partial", "failed", "interrupted"].includes(String(row.outcome))
    || !["committed", "no-commit", "unknown"].includes(String(row.commitState)) || !Array.isArray(row.checks) || row.checks.length > 128
    || !Array.isArray(row.previousAttempts) || row.previousAttempts.length > 31) throw workflowError();
  const identity = parseIdentity(row.identity); const startedAt = workflowTimestamp(row.startedAt); const finishedAt = workflowTimestamp(row.finishedAt);
  const candidateSha = nullableSha(row.candidateSha); const baseSha = nullableSha(row.baseSha);
  if (Date.parse(finishedAt) < Date.parse(startedAt) || startedAt.slice(0, 10) !== identity.date || row.commitState === "committed" && (!baseSha || !candidateSha)) throw workflowError();
  const input = workflowObject(row.sections, PHASE_REPORT_SECTIONS);
  const sections = Object.freeze(Object.fromEntries(PHASE_REPORT_SECTIONS.map((key) => [key, text(input[key])]))) as PhaseReport["sections"];
  const checks = row.checks.map((value): PhaseReportCheck => {
    const check = workflowObject(value, ["command", "candidateSha", "state", "exitCode", "output"]);
    if (!["passed", "failed", "not-run", "unknown"].includes(String(check.state))) throw workflowError();
    const exitCode = check.exitCode === null ? null : Number(check.exitCode);
    if (check.exitCode !== null && (typeof check.exitCode !== "number" || !Number.isSafeInteger(exitCode) || exitCode! < -1 || exitCode! > 255)) throw workflowError();
    const output = check.output === null ? null : parseSourceVersion(check.output);
    if (check.state === "passed" && (exitCode !== 0 || !output) || check.state === "failed" && (exitCode === null || exitCode === 0 || !output)
      || (check.state === "not-run" || check.state === "unknown") && (exitCode !== null || output !== null)) throw workflowError();
    return Object.freeze({ command: text(check.command, 16_384), candidateSha: nullableSha(check.candidateSha), state: check.state as PhaseReportCheck["state"], exitCode, output });
  });
  if (row.outcome === "success" && (!candidateSha || checks.length === 0 || checks.some((check) => check.state !== "passed" || check.candidateSha !== candidateSha))) throw workflowError();
  return Object.freeze({ schemaVersion: PHASE_REPORT_VERSION, identity, outcome: row.outcome as PhaseReport["outcome"], startedAt, finishedAt, baseSha, candidateSha,
    commitState: row.commitState as PhaseReport["commitState"], sections, checks: Object.freeze(checks), previousAttempts: Object.freeze(row.previousAttempts.map(parseSourceVersion)), evidence: parseSourceVersion(row.evidence) });
}
/** Literal private-value scrubber. The host ALSO applies existing sensitive-pattern
 * policy and verifies safe inventory/diff omissions; this alone is not a DLP claim. */
export function redactPhaseReportText(markdown: string, privateValues: readonly string[]): string {
  let result = text(markdown, WORKFLOW_OUTPUT_LIMITS.markdown);
  if (privateValues.length > 1_024 || privateValues.some((value) => !value || value.length > 65_536)) throw workflowError();
  let count = 0;
  for (const value of [...new Set(privateValues)].sort((a, b) => b.length - a.length)) {
    if (result.includes(value)) { count++; result = result.split(value).join("[REDACTED]"); }
  }
  return count ? `${result}\n\nRedaction: private values omitted in ${count} classified value group(s); no private locator is published.\n` : result;
}
export function phaseReportMarkdown(reportInput: PhaseReport): string {
  const report = parsePhaseReport(reportInput); const id = report.identity;
  const code = (value: string) => value.split("\n").map((line) => `    ${line}`).join("\n");
  const lines = [`# Phase report: ${id.phaseId} / attempt ${id.attempt}`, "", `Report schema: ${PHASE_REPORT_VERSION}`, `Reading renderer: ${ARTIFACT_READING_RENDERER_VERSION}`, `Report identity: ${phaseReportIdentity(id)}`,
    `Executor: ${id.executor}; team: ${id.team}; ticket: ${id.ticket ?? "none (ticketless)"}; deployment: ${id.deploymentId}`,
    `Outcome: ${report.outcome}; started: ${report.startedAt}; finished: ${report.finishedAt}`,
    `Base SHA: ${report.baseSha ?? "unknown"}; final candidate SHA: ${report.candidateSha ?? "unknown"}; commit state: ${report.commitState}`,
    `Input evidence: ${report.evidence.ref} @ ${report.evidence.version} sha256=${report.evidence.sha256}`, ""];
  for (const key of PHASE_REPORT_SECTIONS) lines.push(`## ${key}`, "", report.sections[key], "");
  lines.push("## Exact checks", "");
  for (const check of report.checks) lines.push(code(check.command), "", `State: ${check.state}; candidate: ${check.candidateSha ?? "unknown"}; exit: ${check.exitCode ?? "not observed"}; output: ${check.output ? `${check.output.ref} @ ${check.output.version} sha256=${check.output.sha256}` : "none — not proven"}`, "");
  if (report.checks.length === 0) lines.push("No checks recorded — no validation pass is claimed.", "");
  lines.push("## Preserved earlier attempts", "", ...report.previousAttempts.map((source) => `- ${source.ref} @ ${source.version} sha256=${source.sha256}`), "",
    "## Reading view / delivery", "", "Separate deterministic report.html is a reading view, not Lavish. Generation does not prove browser or Obsidian access. Native source-bound delivery records are separate; missing observations are presentation debt.", "");
  const markdown = lines.join("\n");
  if (Buffer.byteLength(markdown) > WORKFLOW_OUTPUT_LIMITS.markdown) throw workflowError();
  return markdown;
}
function parseReceipt(value: unknown): PhaseReportReceipt {
  const row = workflowObject(value, ["schemaVersion", "identity", "reportId", "outcome", "sourceSha256", "htmlSha256"]);
  const identity = parseIdentity(row.identity);
  if (row.schemaVersion !== "phase-report-receipt/v1" || row.reportId !== phaseReportIdentity(identity) || !["success", "partial", "failed", "interrupted"].includes(String(row.outcome))) throw workflowError();
  return Object.freeze({ schemaVersion: "phase-report-receipt/v1", identity, reportId: phaseReportIdentity(identity), outcome: row.outcome as PhaseReport["outcome"], sourceSha256: workflowSha(row.sourceSha256), htmlSha256: workflowSha(row.htmlSha256) });
}
function parseDelivery(value: unknown): PhaseReportDelivery {
  const row = workflowObject(value, ["application", "kind", "reportId", "sourceSha256", "htmlSha256", "observedAt", "evidence"]);
  if (row.application !== "browser" && row.application !== "obsidian" || row.kind !== "native-operator" && row.kind !== "labelled-manual") throw workflowError();
  return Object.freeze({ application: row.application, kind: row.kind, reportId: workflowSha(row.reportId), sourceSha256: workflowSha(row.sourceSha256), htmlSha256: workflowSha(row.htmlSha256), observedAt: workflowTimestamp(row.observedAt), evidence: parseSourceVersion(row.evidence) });
}
function checkDirectory(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw workflowError();
}
function childDirectory(parent: number, name: string): number {
  const path = `/proc/self/fd/${parent}/${name}`;
  try { mkdirSync(path, { mode: 0o700 }); fsyncSync(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { checkDirectory(fd); return fd; } catch (error) { closeSync(fd); throw error; }
}
function readPublic(parent: number, name: string, max: number): Buffer {
  const stat = lstatSync(`/proc/self/fd/${parent}/${name}`);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) throw workflowError();
  return readArtifactFileAt(parent, name, max, "ARTIFACT_STALE");
}
function publishAbsent(parent: number, name: string, bytes: Buffer, max: number): void {
  if (bytes.length > max) throw workflowError();
  try {
    lstatSync(`/proc/self/fd/${parent}/${name}`);
    if (!readPublic(parent, name, max).equals(bytes)) throw workflowError();
    fsyncSync(parent); return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `/proc/self/fd/${parent}/.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  // No compensation: interruptions/aliases remain evidence and reject readback.
  try { linkSync(temporary, `/proc/self/fd/${parent}/${name}`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readPublic(parent, name, max).equals(bytes)) throw error;
    // Another identical publisher won. Preserve our unrelated temporary as
    // forensic evidence rather than unlinking a raced pathname.
    fsyncSync(parent); return;
  }
  unlinkSync(temporary); fsyncSync(parent);
  if (!readPublic(parent, name, max).equals(bytes)) throw workflowError();
}
/** Actual immutable publication. Root is fixed by native service construction,
 * never exposed through tools. No generic output-path policy is relaxed. */
export class PhaseReportService {
  readonly root: string;
  constructor(root: string, readonly host: PhaseReportHost) {
    this.root = workflowPath(root); const fd = openArtifactDirectory(this.root, "ARTIFACT_OUTPUT_CONFLICT");
    try { checkDirectory(fd); } finally { closeSync(fd); }
  }
  #parts(identity: PhaseReportIdentity): readonly string[] {
    return [`${identity.date}-${identity.ticket ?? "ticketless"}-${identity.phaseId}-${identity.deploymentId}`, `attempt-${identity.attempt}`];
  }
  #source(identity: PhaseReportIdentity): string { return join(this.root, ...this.#parts(identity), "report.md"); }
  #directory<T>(identity: PhaseReportIdentity, create: boolean, run: (fd: number) => T): T {
    let fd = openArtifactDirectory(this.root, "ARTIFACT_OUTPUT_CONFLICT");
    try {
      checkDirectory(fd);
      for (const part of this.#parts(identity)) {
        const next = create ? childDirectory(fd, part) : openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        closeSync(fd); fd = next; checkDirectory(fd);
      }
      return run(fd);
    } finally { closeSync(fd); }
  }
  publish(input: PhaseReport): PhaseReportReceipt {
    try {
      const report = parsePhaseReport(input);
      assertNative(() => this.host.authorize("publish", report.identity)); assertNative(() => this.host.verifyReport(report));
      const source = Buffer.from(text(native(() => this.host.sanitize(phaseReportMarkdown(report))), WORKFLOW_OUTPUT_LIMITS.markdown));
      const html = renderReadingMarkdown(source, this.#source(report.identity), ["report.md"]).html;
      if (html.length > WORKFLOW_OUTPUT_LIMITS.html) throw workflowError();
      assertNative(() => this.host.assertPublic(source)); assertNative(() => this.host.assertPublic(html));
      const receipt = parseReceipt({ schemaVersion: "phase-report-receipt/v1", identity: report.identity, reportId: phaseReportIdentity(report.identity), outcome: report.outcome, sourceSha256: workflowDigest(source), htmlSha256: workflowDigest(html) });
      const manifest = Buffer.from(`${JSON.stringify(receipt)}\n`); assertNative(() => this.host.assertPublic(manifest));
      this.#directory(report.identity, true, (fd) => {
        publishAbsent(fd, "report.md", source, WORKFLOW_OUTPUT_LIMITS.markdown);
        publishAbsent(fd, "report.html", html, WORKFLOW_OUTPUT_LIMITS.html);
        publishAbsent(fd, "report.json", manifest, 65_536);
      });
      this.#verify(receipt); assertNative(() => this.host.index(receipt)); return receipt;
    } catch { throw workflowError(); }
  }
  #verify(receipt: PhaseReportReceipt): void {
    this.#directory(receipt.identity, false, (fd) => {
      const source = readPublic(fd, "report.md", WORKFLOW_OUTPUT_LIMITS.markdown); const html = readPublic(fd, "report.html", WORKFLOW_OUTPUT_LIMITS.html);
      const manifest = readPublic(fd, "report.json", 65_536);
      if (workflowDigest(source) !== receipt.sourceSha256 || workflowDigest(html) !== receipt.htmlSha256 || !manifest.equals(Buffer.from(`${JSON.stringify(receipt)}\n`))
        || !renderReadingMarkdown(source, this.#source(receipt.identity), ["report.md"]).html.equals(html)) throw workflowError();
      assertNative(() => this.host.assertPublic(source)); assertNative(() => this.host.assertPublic(html));
    });
  }
  settle(input: PhaseReportReceipt, deliverySources: readonly SourceVersion[] = []): Readonly<Record<string, unknown>> {
    try {
      const receipt = parseReceipt(input); if (!Array.isArray(deliverySources) || deliverySources.length > 2) throw workflowError();
      assertNative(() => this.host.authorize("settle", receipt.identity)); this.#verify(receipt);
      assertNative(() => this.host.verifyCanonical(receipt)); assertNative(() => this.host.index(receipt));
      const known = native(() => this.host.loadDeliverySources(receipt));
      if (!Array.isArray(known) || known.length > 2 || new Set(deliverySources.map((source) => JSON.stringify(parseSourceVersion(source)))).size !== deliverySources.length) throw workflowError();
      const combined = [...new Map([...known, ...deliverySources].map((source) => { const parsed = parseSourceVersion(source); return [JSON.stringify(parsed), parsed] as const; })).values()];
      if (combined.length > 2) throw workflowError();
      const delivered = new Set<string>(); const observations: PhaseReportDelivery[] = [];
      for (const source of combined) {
        const delivery = parseDelivery(native(() => this.host.resolveDelivery(parseSourceVersion(source))));
        if (delivery.reportId !== receipt.reportId || delivery.sourceSha256 !== receipt.sourceSha256 || delivery.htmlSha256 !== receipt.htmlSha256 || delivered.has(delivery.application)) throw workflowError();
        if (JSON.stringify(delivery.evidence) !== JSON.stringify(source)) throw workflowError();
        assertNative(() => this.host.assertPublic(Buffer.from(JSON.stringify(delivery))));
        delivered.add(delivery.application); observations.push(delivery);
      }
      for (const observation of observations) assertNative(() => this.host.recordDelivery(receipt, observation));
      const debt = ["browser", "obsidian"].filter((app) => !delivered.has(app));
      return Object.freeze({ schemaVersion: "phase-report-status/v1", reportId: receipt.reportId, outcome: receipt.outcome, sourceSha256: receipt.sourceSha256,
        htmlGenerated: true, presentationDebt: Object.freeze(debt), canonicalEvidenceAvailable: true, dependentWorkMayContinue: true,
        phaseDeliveryReady: receipt.outcome === "success" && debt.length === 0, humanProductUatClaimed: false });
    } catch { throw workflowError(); }
  }
}
/** Pure CAS update for the EXISTING owner Markdown. Native owner retains its
 * mutex/file publication. Exact duplicates are idempotent; conflicts keep history. */
export function indexPhaseReport(ownerMarkdown: string, expectedSha256: string, input: PhaseReportReceipt): { markdown: string; sha256: string; changed: boolean } {
  const receipt = parseReceipt(input); const expected = workflowSha(expectedSha256);
  const prefix = "<!-- pa-phase-report/v1 "; const suffix = " -->";
  const lines = ownerMarkdown.split("\n"); const seen = new Set<string>();
  let duplicate = false;
  const description = (entry: PhaseReportReceipt) => `- Phase ${entry.identity.phaseId}, attempt ${entry.identity.attempt}: ${entry.outcome}; report ${entry.reportId}; source SHA-256 ${entry.sourceSha256}. Delivery debt is tracked separately.`;
  for (const [index, line] of lines.entries()) {
    if (!line.includes("pa-phase-report/v1")) continue;
    if (!line.startsWith(prefix) || !line.endsWith(suffix)) throw workflowError();
    const encoded = line.slice(prefix.length, -suffix.length); const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) throw workflowError();
    const previous = parseReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)));
    if (seen.has(previous.reportId) || lines[index + 1] !== description(previous)) throw workflowError(); seen.add(previous.reportId);
    if (previous.reportId === receipt.reportId) {
      if (JSON.stringify(previous) !== JSON.stringify(receipt)) throw workflowError(); duplicate = true;
    }
  }
  if (duplicate) return { markdown: ownerMarkdown, sha256: workflowDigest(ownerMarkdown), changed: false };
  if (workflowDigest(ownerMarkdown) !== expected) throw workflowError();
  const marker = `${prefix}${Buffer.from(JSON.stringify(receipt)).toString("base64")}${suffix}`;
  const markdown = `${ownerMarkdown.replace(/\n*$/, "")}\n\n${marker}\n${description(receipt)}\n`;
  return { markdown, sha256: workflowDigest(markdown), changed: true };
}

function indexedDeliveries(ownerMarkdown: string, receipt: PhaseReportReceipt): PhaseReportDelivery[] {
  const prefix = "<!-- pa-phase-delivery/v1 "; const suffix = " -->"; const deliveries: PhaseReportDelivery[] = [];
  const seen = new Set<string>();
  for (const line of ownerMarkdown.split("\n").filter((line) => line.includes("pa-phase-delivery/v1"))) {
    if (!line.startsWith(prefix) || !line.endsWith(suffix)) throw workflowError();
    const encoded = line.slice(prefix.length, -suffix.length); const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw workflowError();
    const observation = parseDelivery(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const key = `${observation.reportId}:${observation.application}`;
    if (seen.has(key)) throw workflowError(); seen.add(key);
    if (observation.reportId === receipt.reportId) {
      if (observation.sourceSha256 !== receipt.sourceSha256 || observation.htmlSha256 !== receipt.htmlSha256) throw workflowError();
      deliveries.push(observation);
    }
  }
  return deliveries;
}
export function phaseReportDeliverySources(ownerMarkdown: string, input: PhaseReportReceipt): readonly SourceVersion[] {
  return Object.freeze(indexedDeliveries(ownerMarkdown, parseReceipt(input)).map((delivery) => delivery.evidence));
}
export function indexPhaseReportDelivery(ownerMarkdown: string, expectedSha256: string, input: PhaseReportReceipt, deliveryInput: PhaseReportDelivery): { markdown: string; sha256: string; changed: boolean } {
  const receipt = parseReceipt(input); const delivery = parseDelivery(deliveryInput); const expected = workflowSha(expectedSha256);
  // A delivery cannot create an unindexed report or repair a conflicting owner entry.
  if (indexPhaseReport(ownerMarkdown, workflowDigest(ownerMarkdown), receipt).changed || delivery.reportId !== receipt.reportId
    || delivery.sourceSha256 !== receipt.sourceSha256 || delivery.htmlSha256 !== receipt.htmlSha256) throw workflowError();
  const previous = indexedDeliveries(ownerMarkdown, receipt).find((item) => item.application === delivery.application);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(delivery)) throw workflowError();
    return { markdown: ownerMarkdown, sha256: workflowDigest(ownerMarkdown), changed: false };
  }
  if (workflowDigest(ownerMarkdown) !== expected) throw workflowError();
  const markdown = `${ownerMarkdown.replace(/\n*$/, "")}\n\n<!-- pa-phase-delivery/v1 ${Buffer.from(JSON.stringify(delivery)).toString("base64")} -->\n`;
  return { markdown, sha256: workflowDigest(markdown), changed: true };
}
