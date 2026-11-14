import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readArtifactFile } from "../artifacts/manifest.js";
import { immutableFile } from "./confirmation-record.js";
import { documentReject, type DocumentPackage } from "./package-contract.js";
import { DOCUMENT_READER_LIMITS, renderDocumentReader } from "./reader.js";

/** New inactive delivery owner. Complete derivation precedes all writes; each
 * file is private/no-replace and prefix-recoverable through the existing owner.
 * Manifest is published LAST; no entry is advertised before exact full readback.
 * Partial pending outputs are never served/advertised and are not overwritten.
 * This is not a cross-file atomic rename or hostile-same-UID isolation claim. */
export function presentFullDocumentReader(subject: DocumentPackage, root: string, snapshot: (sha256: string) => Uint8Array): Record<string, unknown> {
  const bundle = renderDocumentReader(subject, snapshot);
  const folder = `agent-teams/requirements/artifacts/presentations/${bundle.manifest.subjectSha256}/${bundle.deliverySha256}`;
  const resultFolder = `agent-teams/requirements/artifacts/presentation-results/${bundle.manifest.subjectSha256}`;
  const resultName = `${bundle.deliverySha256}.json`;
  const resultBytes = Buffer.from(JSON.stringify({ schemaVersion: "pa-document-reader-publication/v1", deliverySha256: bundle.deliverySha256, manifestSha256: bundle.manifestSha256 }));
  const exists = (path: string) => {
    try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const verify = () => {
    for (const [path, expected] of bundle.files) {
      if (!readArtifactFile(join(root, folder, path), DOCUMENT_READER_LIMITS.outputBytes, "ARTIFACT_STALE").equals(expected)) documentReject("DOCUMENT_CONFLICT");
    }
  };
  const completed = exists(join(root, resultFolder, resultName));
  if (completed || exists(join(root, folder, "manifest.json"))) {
    // Completed/tampered deliveries are never silently rebuilt. A manifest whose
    // reply/result write was lost is observation-only completion recovery.
    verify();
    if (completed && !readArtifactFile(join(root, resultFolder, resultName), 4096, "ARTIFACT_STALE").equals(resultBytes)) documentReject("DOCUMENT_CONFLICT");
  }
  immutableFile(root, resultFolder, `${bundle.deliverySha256}.intent.json`, resultBytes);
  for (const [path, bytes] of bundle.files) {
    if (!/^(?:index\.html|manifest\.json|raw\/member-[1-9][0-9]*\.(?:md|txt|png|jpg)|members\/member-[1-9][0-9]*\.html)$/.test(path)) documentReject("DOCUMENT_SOURCE");
    immutableFile(root, dirname(`${folder}/${path}`), basename(path), bytes);
  }
  verify();
  immutableFile(root, resultFolder, resultName, resultBytes);
  return { ...bundle.manifest, entry: pathToFileURL(join(root, folder, "index.html")).href,
    manifest: pathToFileURL(join(root, folder, "manifest.json")).href, manifestSha256: bundle.manifestSha256,
    approval: "not-issued", opening: "not-requested", installedQualification: "not-asserted" };
}
