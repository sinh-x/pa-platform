import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { digest } from "../workflows/contracts.js";
import { DocumentPackageError, documentPackageSha, documentReject, parseDocumentPackage, type DocumentPackage } from "./package-contract.js";
import { validateDocumentBytes } from "./package-tools.js";
import { DOCUMENT_READER_LIMITS, DOCUMENT_READER_VERSION, type DocumentReaderBundle } from "./reader.js";

/** Trusted native controls can only REDUCE the published finite ceilings.
 * These are not tool/request fields, effect grants or an arbitrary worker port. */
export interface ReaderWorkerControl { signal?: AbortSignal; milliseconds?: number; outputBytes?: number }
const CLEANUP_MILLISECONDS = 2_000;
const active = new Set<Worker>();
const unknown = new Set<Worker>();
/** Observational only; no handles, reset, settlement or authority overrides. */
export function documentReaderWorkerStatus() { return Object.freeze({ active: active.size, uncertain: unknown.size }); }
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const extensions = { "text/markdown": "md", "text/plain": "txt", "image/png": "png", "image/jpeg": "jpg" };

/** Validate complete worker inventory before the publisher can see ANY output.
 * Worker input/output is private data, never native authority. */
function checkedBundle(value: unknown, subject: DocumentPackage, maximumBytes: number): DocumentReaderBundle {
  if (!value || typeof value !== "object") return documentReject("DOCUMENT_UNCERTAIN");
  const row = value as Record<string, unknown>;
  if (row.ok === false) {
    const codes = ["DOCUMENT_INPUT", "DOCUMENT_SOURCE", "DOCUMENT_STALE", "DOCUMENT_CONFLICT", "DOCUMENT_UNAVAILABLE", "DOCUMENT_UNCERTAIN"] as const;
    const code = codes.find(code => code === row.code);
    return documentReject(code ?? "DOCUMENT_UNCERTAIN");
  }
  if (row.ok !== true || !sha(row.deliverySha256) || !sha(row.manifestSha256) || !Array.isArray(row.files)
    || row.files.length !== subject.members.length * 2 + 2 || !row.manifest || typeof row.manifest !== "object") return documentReject("DOCUMENT_UNCERTAIN");
  const manifest = row.manifest as DocumentReaderBundle["manifest"], files = new Map<string, Buffer>();
  const members = subject.members.map((member, index) => ({ id: member.id, role: member.role, mediaType: member.mediaType, description: member.description,
    bytes: member.bytes, sha256: member.sha256, raw: `raw/member-${index + 1}.${extensions[member.mediaType]}`, companion: `members/member-${index + 1}.html` }));
  const required = new Set(["index.html", "manifest.json", ...members.flatMap(member => [member.raw, member.companion])]);
  let total = 0;
  for (const item of row.files) {
    if (!item || typeof item !== "object" || typeof item.path !== "string" || !required.has(item.path) || files.has(item.path) || !(item.bytes instanceof Uint8Array)) return documentReject("DOCUMENT_UNCERTAIN");
    total += item.bytes.byteLength;
    if (total > maximumBytes) return documentReject("DOCUMENT_UNAVAILABLE");
    files.set(item.path, Buffer.from(item.bytes));
  }
  if (manifest.schemaVersion !== DOCUMENT_READER_VERSION || manifest.subjectSha256 !== documentPackageSha(subject)
    || manifest.deliverySha256 !== row.deliverySha256 || manifest.revision !== subject.revision || manifest.generationState !== "UNAPPROVED-at-generation"
    || manifest.observation !== "not-performed" || JSON.stringify(manifest.effects) !== JSON.stringify(subject.effects)
    || JSON.stringify(manifest.members) !== JSON.stringify(members) || manifest.renderer?.id !== DOCUMENT_READER_VERSION || !sha(manifest.renderer.implementationSha256)
    || !Array.isArray(manifest.outputs) || manifest.outputs.length !== files.size - 1) return documentReject("DOCUMENT_UNCERTAIN");
  const identity = digest(JSON.stringify({ schemaVersion: "pa-document-reader-identity/v1", subjectSha256: manifest.subjectSha256, revision: subject.revision, effects: subject.effects, members, renderer: manifest.renderer }));
  if (identity !== row.deliverySha256 || digest(files.get("manifest.json")!) !== row.manifestSha256
    || !files.get("manifest.json")!.equals(Buffer.from(JSON.stringify(manifest, null, 2) + "\n"))) return documentReject("DOCUMENT_UNCERTAIN");
  const seen = new Set<string>();
  for (const output of manifest.outputs) {
    if (!output || output.path === "manifest.json" || seen.has(output.path)) return documentReject("DOCUMENT_UNCERTAIN");
    const bytes = files.get(output.path);
    if (!bytes || output.bytes !== bytes.length || output.sha256 !== digest(bytes)) return documentReject("DOCUMENT_UNCERTAIN");
    seen.add(output.path);
  }
  for (const [index, member] of members.entries()) validateDocumentBytes(subject.members[index]!, files.get(member.raw)!);
  return { deliverySha256: row.deliverySha256, manifestSha256: row.manifestSha256, manifest, files };
}

/** Wall deadline is enforced OUTSIDE the renderer's thread. No filesystem
 * publication occurs here. A usable result requires proven worker exit. Cleanup
 * gets a separate finite 2-second budget; expiry returns UNCERTAIN, not success,
 * and blocks further worker launches in this owner until the actual exit event.
 * A parent process crash terminates its worker threads, not an external browser. */
export async function renderDocumentReaderInWorker(input: DocumentPackage, snapshot: (sha256: string) => Uint8Array,
  control: ReaderWorkerControl = {}): Promise<DocumentReaderBundle> {
  const started = performance.now(), milliseconds = control.milliseconds ?? DOCUMENT_READER_LIMITS.milliseconds,
    maximumBytes = control.outputBytes ?? DOCUMENT_READER_LIMITS.outputBytes;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > DOCUMENT_READER_LIMITS.milliseconds
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > DOCUMENT_READER_LIMITS.outputBytes) return documentReject("DOCUMENT_INPUT");
  if (control.signal?.aborted) return documentReject("DOCUMENT_UNAVAILABLE");
  if (unknown.size) return documentReject("DOCUMENT_UNCERTAIN");
  if (active.size >= 2) return documentReject("DOCUMENT_CONFLICT");
  const subject = parseDocumentPackage(input);
  const sources = subject.members.map(member => {
    const bytes = Uint8Array.from(snapshot(member.sha256)); validateDocumentBytes(member, bytes); return bytes;
  });
  const remaining = milliseconds - (performance.now() - started);
  if (remaining <= 0 || control.signal?.aborted) return documentReject("DOCUMENT_UNAVAILABLE");
  // Source fixtures use the owner-built worker, not tsx/eval/ambient loaders.
  // Production resolves the literal sibling in the shipped immutable closure.
  const workerFile = new URL(import.meta.url.endsWith(".ts") ? "../../dist/documents/reader-worker.js" : "./reader-worker.js", import.meta.url);
  let worker: Worker;
  try { worker = new Worker(fileURLToPath(workerFile), { workerData: { subject, sources }, transferList: sources.map(bytes => bytes.buffer),
    env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 }, stdout: true, stderr: true }); }
  catch { return documentReject("DOCUMENT_UNAVAILABLE"); }
  active.add(worker);
  return new Promise((resolve, reject) => {
    let packet: unknown, received = false, stopped = false, exited = false, reason: DocumentPackageError | undefined, settled = false;
    let cleanup: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: DocumentPackageError, bundle?: DocumentReaderBundle) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cleanup); control.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(bundle!);
    };
    const stop = (code: "DOCUMENT_UNAVAILABLE" | "DOCUMENT_UNCERTAIN") => {
      reason ??= new DocumentPackageError(code);
      if (stopped) return; stopped = true;
      cleanup = setTimeout(() => { if (!exited) { unknown.add(worker); finish(new DocumentPackageError("DOCUMENT_UNCERTAIN")); } }, CLEANUP_MILLISECONDS);
      void worker.terminate().catch(() => { if (!exited) { unknown.add(worker); finish(new DocumentPackageError("DOCUMENT_UNCERTAIN")); } });
    };
    const abort = () => stop("DOCUMENT_UNAVAILABLE");
    const timer = setTimeout(abort, remaining);
    // The fixed worker has no useful stdout/stderr contract. Bound unexpected
    // output and never spill an unchecked source/exception into a tool reply.
    let noise = 0;
    const output = (bytes: Buffer) => { noise += bytes.length; if (noise > 4096) stop("DOCUMENT_UNCERTAIN"); };
    worker.stdout?.on("data", output); worker.stderr?.on("data", output);
    worker.on("message", value => { if (received) stop("DOCUMENT_UNCERTAIN"); else { packet = value; received = true; } });
    worker.on("messageerror", () => stop("DOCUMENT_UNCERTAIN"));
    worker.on("error", () => stop("DOCUMENT_UNAVAILABLE"));
    worker.once("exit", code => {
      exited = true; active.delete(worker); unknown.delete(worker);
      if (reason) return finish(reason);
      if (code !== 0 || !received) return finish(new DocumentPackageError("DOCUMENT_UNAVAILABLE"));
      if (performance.now() - started > milliseconds) return finish(new DocumentPackageError("DOCUMENT_UNAVAILABLE"));
      try {
        const bundle = checkedBundle(packet, subject, maximumBytes);
        if (performance.now() - started > milliseconds) return finish(new DocumentPackageError("DOCUMENT_UNAVAILABLE"));
        finish(undefined, bundle);
      } catch (error) { finish(error instanceof DocumentPackageError ? error : new DocumentPackageError("DOCUMENT_UNCERTAIN")); }
    });
    control.signal?.addEventListener("abort", abort, { once: true });
    if (control.signal?.aborted) abort();
  });
}
