import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readArtifactFile } from "../artifacts/manifest.js";
import { SHA256, text } from "../workflows/contracts.js";
import { immutableFile } from "./confirmation-record.js";
import { documentReject, type DocumentPackage } from "./package-contract.js";
import { DOCUMENT_READER_LIMITS, type DocumentReaderBundle } from "./reader.js";
import { renderDocumentReaderInWorker, type ReaderWorkerControl } from "./reader-worker-owner.js";

const exists = (path: string) => {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
function coordinates(bundle: DocumentReaderBundle) {
  const folder = `agent-teams/requirements/artifacts/presentations/${bundle.manifest.subjectSha256}/${bundle.deliverySha256}`;
  const resultFolder = `agent-teams/requirements/artifacts/presentation-results/${bundle.manifest.subjectSha256}`;
  const resultName = `${bundle.deliverySha256}.json`;
  const resultBytes = Buffer.from(JSON.stringify({ schemaVersion: "pa-document-reader-publication/v1", deliverySha256: bundle.deliverySha256, manifestSha256: bundle.manifestSha256 }));
  return { folder, resultFolder, resultName, resultBytes };
}
function verify(bundle: DocumentReaderBundle, root: string): void {
  const { folder } = coordinates(bundle);
  for (const [path, expected] of bundle.files) {
    if (!readArtifactFile(join(root, folder, path), DOCUMENT_READER_LIMITS.outputBytes, "ARTIFACT_STALE").equals(expected)) documentReject("DOCUMENT_CONFLICT");
  }
}
function result(bundle: DocumentReaderBundle, root: string): Record<string, unknown> {
  const { folder } = coordinates(bundle);
  return { ...bundle.manifest, entry: pathToFileURL(join(root, folder, "index.html")).href,
    manifest: pathToFileURL(join(root, folder, "manifest.json")).href, manifestSha256: bundle.manifestSha256,
    approval: "not-issued", opening: "not-requested", installedQualification: "not-asserted" };
}
/** Worker termination and complete derivation precede every publication effect.
 * No entry is advertised before exact complete readback. Original pending prefix
 * recovery/no-replace semantics remain separate from completed immutable output.
 * This owner is not yet selected by a native document tool/profile. */
export async function presentFullDocumentReader(subject: DocumentPackage, root: string, snapshot: (sha256: string) => Uint8Array,
  control: ReaderWorkerControl = {}): Promise<Record<string, unknown>> {
  const bundle = await renderDocumentReaderInWorker(subject, snapshot, control);
  if (control.signal?.aborted) documentReject("DOCUMENT_UNAVAILABLE");
  const { folder, resultFolder, resultName, resultBytes } = coordinates(bundle);
  const completed = exists(join(root, resultFolder, resultName));
  if (completed || exists(join(root, folder, "manifest.json"))) {
    verify(bundle, root);
    if (completed && !readArtifactFile(join(root, resultFolder, resultName), 4096, "ARTIFACT_STALE").equals(resultBytes)) documentReject("DOCUMENT_CONFLICT");
  }
  immutableFile(root, resultFolder, `${bundle.deliverySha256}.intent.json`, resultBytes);
  for (const [path, bytes] of bundle.files) {
    if (control.signal?.aborted) documentReject("DOCUMENT_UNAVAILABLE");
    if (!/^(?:index\.html|manifest\.json|raw\/member-[1-9][0-9]*\.(?:md|txt|png|jpg)|members\/member-[1-9][0-9]*\.html)$/.test(path)) documentReject("DOCUMENT_SOURCE");
    immutableFile(root, dirname(`${folder}/${path}`), basename(path), bytes);
  }
  verify(bundle, root);
  if (control.signal?.aborted) documentReject("DOCUMENT_UNAVAILABLE");
  immutableFile(root, resultFolder, resultName, resultBytes);
  return result(bundle, root);
}
/** Read-only bound delivery consumer. Re-derives exact native bytes in the
 * bounded worker, then verifies every immutable output and completion record.
 * No path/URL/program/callback import and no repair of a completed delivery. */
export async function inspectFullDocumentReader(subject: DocumentPackage, root: string, snapshot: (sha256: string) => Uint8Array,
  deliverySha256: string, control: ReaderWorkerControl = {}): Promise<Record<string, unknown>> {
  text(deliverySha256, SHA256);
  const bundle = await renderDocumentReaderInWorker(subject, snapshot, control);
  if (bundle.deliverySha256 !== deliverySha256) documentReject("DOCUMENT_STALE");
  verify(bundle, root);
  const { resultFolder, resultName, resultBytes } = coordinates(bundle);
  if (!readArtifactFile(join(root, resultFolder, resultName), 4096, "ARTIFACT_STALE").equals(resultBytes)) documentReject("DOCUMENT_CONFLICT");
  if (control.signal?.aborted) documentReject("DOCUMENT_UNAVAILABLE");
  return result(bundle, root);
}
