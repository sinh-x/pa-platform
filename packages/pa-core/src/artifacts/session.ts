import { spawn } from "node:child_process";
import { closeSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { exportFeedback, type FeedbackBinding } from "./feedback.js";
import { artifactSha256, validateArtifactManifest, type ArtifactAnchor, type ArtifactIdentity } from "./manifest.js";
import { artifactDiagnostic } from "./policy.js";
import {
  jsonBytes, opaqueId, privateDirectory, processBirth, readPrivate, replacePrivate,
  REVIEW_START_MS, REVIEW_STOP_MS, sessionDirectory, withReviewLock, type ReviewContext,
} from "./runtime.js";

export interface ReviewRecord extends FeedbackBinding {
  schema: "pa-artifact-session/v1"; context: ReviewContext; manifestPath: string;
  identity: ArtifactIdentity; anchors: ArtifactAnchor[]; assets: string;
  token: string; state: "starting" | "running" | "stopped" | "ended";
  supervisorPid: number; supervisorBirth: string; port: number; startDeadline: number;
}
export function writeReviewRecord(fd: number, record: ReviewRecord): void { replacePrivate(fd, "owner.json", jsonBytes(record)); }
export function readReviewRecord(fd: number, context: ReviewContext, sessionId: string): ReviewRecord {
  try {
    const record = JSON.parse(readPrivate(fd, "owner.json", 268_435_456).toString("utf8")) as ReviewRecord;
    if (record.schema !== "pa-artifact-session/v1" || record.sessionId !== sessionId
        || !context || !["pi", "opencode", "claudecode"].includes(context.adapter)
        || !/^d-[a-f0-9]{6,32}$/.test(context.deployment) || !context.root.startsWith("/")
        || !Number.isSafeInteger(context.ownerPid) || context.ownerPid <= 1
        || typeof context.ownerBirth !== "string" || !/^[a-f0-9-]{36}:[0-9]+$/.test(context.ownerBirth)
        || JSON.stringify(record.context) !== JSON.stringify(context)
        || !/^[a-f0-9]{48}$/.test(record.token) || !["starting", "running", "stopped", "ended"].includes(record.state)
        || !Number.isSafeInteger(record.supervisorPid) || !Number.isSafeInteger(record.port) || !Number.isSafeInteger(record.startDeadline)
        || record.port < 0 || record.port > 65535 || typeof record.supervisorBirth !== "string"
        || typeof record.manifestPath !== "string" || typeof record.assets !== "string"
        || !Array.isArray(record.anchors)) throw new Error();
    return record;
  } catch { throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT"); }
}
export function reviewFresh(record: ReviewRecord): boolean {
  try { validateArtifactManifest(record.manifestPath, record.identity); return true; }
  catch { return false; }
}
export function reviewAlive(record: ReviewRecord): boolean {
  return record.supervisorPid > 1 && processBirth(record.supervisorPid) === record.supervisorBirth;
}
export function reviewPayload(record: ReviewRecord, fresh = reviewFresh(record)): Record<string, unknown> {
  return {
    sessionId: record.sessionId, ...record.identity,
    url: record.port ? `http://127.0.0.1:${record.port}/${record.token}/` : null,
    owner: { adapter: record.context.adapter, deployment: record.context.deployment,
      processPid: record.context.ownerPid, processBirth: record.context.ownerBirth,
      supervisorPid: record.supervisorPid, supervisorBirth: record.supervisorBirth, stateId: record.sessionId },
    ownership: "owned", freshness: fresh ? "current" : "stale",
  };
}
export function reviewStatus(context: ReviewContext, sessionId: string): { status: string; payload: Record<string, unknown> } {
  const fd = sessionDirectory(context, sessionId);
  try {
    const record = readReviewRecord(fd, context, sessionId);
    const fresh = reviewFresh(record);
    const status = !fresh ? "stale" : record.state === "ended" ? "ended"
      : record.state === "running" && reviewAlive(record) ? "running" : "stopped";
    return { status, payload: reviewPayload(record, fresh) };
  } finally { closeSync(fd); }
}

/** No arbitrary HTTP destinations: derive the exact owned loopback endpoint
 * only after private record and process-birth verification. Never signal PIDs. */
export async function reviewControl(record: ReviewRecord, operation: "start" | "stop" | "consume"): Promise<void> {
  if (!reviewAlive(record) || !record.port) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
  try {
    // Use a direct HTTP socket, not fetch's replaceable/global dispatcher or
    // inherited proxy configuration. The only destination is this owned port.
    await new Promise<void>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: record.port,
        path: `/${record.token}/control/${operation}`, method: "POST",
        headers: { authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(750) }, response => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 4096) response.destroy(artifactDiagnostic("ARTIFACT_RUNTIME_FAILED"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode === 200) { resolve(); return; }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString()) as { diagnostic?: string };
            if (data.diagnostic === "ARTIFACT_STALE") { reject(artifactDiagnostic("ARTIFACT_STALE")); return; }
          } catch { /* redacted below */ }
          reject(artifactDiagnostic("ARTIFACT_RUNTIME_FAILED"));
        });
      });
      req.on("error", reject); req.end();
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ARTIFACT_STALE:")) throw error;
    throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
  }
}

export type ReviewLauncher = (path: string) => void;
const launchSupervisor: ReviewLauncher = (path) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./supervisor.js", import.meta.url)), path], {
    env: { TZ: "UTC", LC_ALL: "C.UTF-8" }, stdio: "ignore", detached: true,
  });
  child.on("error", () => { /* parent detects failed readiness within deadline */ });
  child.unref();
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startReview(context: ReviewContext, manifestPath: string, assets: string,
    launcher: ReviewLauncher = launchSupervisor): Promise<{ status: string; payload: Record<string, unknown> }> {
  const started = performance.now();
  const artifact = validateArtifactManifest(manifestPath);
  const sessionId = createHash("sha256").update(JSON.stringify([context, artifact.identity])).digest("hex").slice(0, 48);
  const path = join(context.root, sessionId);
  const initial = withReviewLock(context, () => {
    const fd = privateDirectory(path, true);
    try {
      let exists = true;
      try { readPrivate(fd, "owner.json", 268_435_456); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
      const prior = exists ? readReviewRecord(fd, context, sessionId) : undefined;
      if (prior) {
        validateArtifactManifest(manifestPath, prior.identity);
        if (prior.state === "ended") throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
        if (prior.state === "starting" && prior.supervisorPid === 0 && Date.now() < prior.startDeadline) return { record: prior, launch: false };
        if (prior.state === "running" || prior.state === "starting") {
          const birth = processBirth(prior.supervisorPid);
          if (birth && birth !== prior.supervisorBirth) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
          if (birth) return { record: prior, launch: false };
          // Missing process, not PID reuse: same private owner may restart its
          // immutable artifact, retaining the entire acknowledged journal.
        }
      }
      replacePrivate(fd, "snapshot.html", artifact.html);
      const record: ReviewRecord = {
        schema: "pa-artifact-session/v1", context, sessionId, manifestPath, identity: artifact.identity,
        anchors: artifact.manifest.anchors, assets, token: opaqueId(), state: "starting",
        supervisorPid: 0, supervisorBirth: "", port: 0, startDeadline: Date.now() + REVIEW_START_MS - 1000,
      };
      writeReviewRecord(fd, record);
      return { record, launch: true };
    } finally { closeSync(fd); }
  });
  if (!initial.launch && initial.record.state === "running") {
    await reviewControl(initial.record, "start");
    return { status: "running", payload: reviewPayload(initial.record) };
  }
  if (initial.launch) launcher(path);
  while (performance.now() - started < REVIEW_START_MS - 500) {
    await sleep(25);
    const fd = sessionDirectory(context, sessionId);
    try {
      const record = readReviewRecord(fd, context, sessionId);
      if (record.state === "running" && reviewAlive(record)) {
        try {
          validateArtifactManifest(manifestPath, artifact.identity);
          if (artifactSha256(readPrivate(fd, "snapshot.html", artifact.html.length)) !== artifact.identity.htmlSha256) throw artifactDiagnostic("ARTIFACT_STALE");
        } catch (error) {
          await reviewControl(record, "stop");
          throw error;
        }
        return { status: "running", payload: reviewPayload(record, true) };
      }
      if (record.state === "stopped" || record.state === "ended") break;
    } finally { closeSync(fd); }
  }
  // Partial startup cleans itself via the supervisor readiness deadline/owner
  // check. Never signal an unverified or reused PID to manufacture cleanup.
  const fd = sessionDirectory(context, sessionId);
  try {
    const record = readReviewRecord(fd, context, sessionId);
    if (record.state === "running" && reviewAlive(record)) await reviewControl(record, "stop");
    else if (!processBirth(record.supervisorPid)) {
      try { unlinkSync(`/proc/self/fd/${fd}/snapshot.html`); } catch { /* not published */ }
      record.state = "stopped"; writeReviewRecord(fd, record);
    }
  } finally { closeSync(fd); }
  throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
}

export async function stopReview(context: ReviewContext, sessionId: string): Promise<{ status: string; payload: Record<string, unknown> }> {
  const started = performance.now();
  const fd = sessionDirectory(context, sessionId);
  try {
    const record = readReviewRecord(fd, context, sessionId);
    if (record.state === "stopped" || record.state === "ended") return { status: record.state, payload: reviewPayload(record) };
    if (!reviewAlive(record)) {
      if (processBirth(record.supervisorPid)) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
      if (record.supervisorPid === 0 && Date.now() < record.startDeadline) throw artifactDiagnostic("ARTIFACT_OWNER_CONFLICT");
      try { unlinkSync(`/proc/self/fd/${fd}/snapshot.html`); } catch { /* already cleaned */ }
      record.state = "stopped"; writeReviewRecord(fd, record);
      return { status: "stopped", payload: reviewPayload(record) };
    }
    await reviewControl(record, "stop");
    while (performance.now() - started < REVIEW_STOP_MS - 250) {
      const current = readReviewRecord(fd, context, sessionId);
      if ((current.state === "stopped" || current.state === "ended") && !reviewAlive(current)) {
        return { status: current.state, payload: reviewPayload(current) };
      }
      await sleep(20);
    }
    throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
  } finally { closeSync(fd); }
}

export async function consumeFeedback(context: ReviewContext, sessionId: string, output: string, timeout: number): Promise<{ status: string; payload: Record<string, unknown> }> {
  const started = performance.now();
  const fd = sessionDirectory(context, sessionId);
  try {
    do {
      const record = readReviewRecord(fd, context, sessionId);
      validateArtifactManifest(record.manifestPath, record.identity);
      const result = exportFeedback(fd, record, output);
      if (result.status === "exported") {
        if (record.state === "running" && reviewAlive(record)) await reviewControl(record, "consume");
        return { status: result.status, payload: { sessionId, eventCount: result.eventCount } };
      }
      if (performance.now() - started >= timeout) break;
      await sleep(Math.min(25, timeout));
    } while (true);
    return { status: "no-feedback", payload: { sessionId, eventCount: 0 } };
  } finally { closeSync(fd); }
}
