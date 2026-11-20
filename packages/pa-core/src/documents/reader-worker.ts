import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { DocumentPackageError, parseDocumentPackage } from "./package-contract.js";
import { renderDocumentReader } from "./reader.js";

/** Fixed private derivation worker. No paths, programs, URLs, callbacks or
 * authority imports. It cannot publish files or launch a reader. */
if (isMainThread || !parentPort) throw new Error("DOCUMENT_UNAVAILABLE");
try {
  const subject = parseDocumentPackage(workerData.subject);
  if (!Array.isArray(workerData.sources) || workerData.sources.length !== subject.members.length) throw new Error();
  const sources = new Map<string, Uint8Array>();
  subject.members.forEach((member, index) => {
    const bytes = workerData.sources[index];
    if (!(bytes instanceof Uint8Array)) throw new Error();
    sources.set(member.sha256, bytes);
  });
  const bundle = renderDocumentReader(subject, sha => { const bytes = sources.get(sha); if (!bytes) throw new Error(); return bytes; }, workerData.historicalRenderer);
  const files = [...bundle.files].map(([path, bytes]) => ({ path, bytes: Uint8Array.from(bytes) }));
  parentPort.postMessage({ ok: true, deliverySha256: bundle.deliverySha256, manifestSha256: bundle.manifestSha256, manifest: bundle.manifest, files }, files.map(file => file.bytes.buffer));
} catch (error) {
  const code = error instanceof DocumentPackageError ? error.code : "DOCUMENT_UNAVAILABLE";
  parentPort.postMessage({ ok: false, code });
} finally { parentPort.close(); }
