import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AdvisoryFiles } from "../operations/files.js";
import { renderMarkdown, ARTIFACT_RENDERER_VERSION } from "../artifacts/render.js";
import { digest } from "../workflows/contracts.js";
import { DOCUMENT_LIMITS, documentPackageSha, documentReject, type DocumentPackage } from "./package-contract.js";
import { validateDocumentBytes } from "./package-tools.js";

/** Derived companions only. Never opens a viewer, issues a decision or rewrites
 * the package. Existing escaped/CSP renderer remains the markup safety owner. */
export function presentDocumentPackage(subject: DocumentPackage, artifactRoot: string, snapshot: (sha: string) => Buffer): Record<string, unknown> {
  const sha256 = documentPackageSha(subject), renderer = ARTIFACT_RENDERER_VERSION;
  const folder = `agent-teams/requirements/artifacts/presentations/${sha256}/${digest(renderer)}`;
  const files = new AdvisoryFiles(artifactRoot);
  const save = (path: string, content: string): void => {
    const bytes = Buffer.from(content);
    try {
      const old = files.file(path) as Buffer;
      if (!old.equals(bytes)) documentReject("DOCUMENT_CONFLICT");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    files.file(folder, undefined, true); files.file(path, content);
  };
  const members = subject.members.map(member => {
    const bytes = snapshot(member.sha256); validateDocumentBytes(member, bytes);
    if (!member.mediaType.startsWith("text/")) return { id: member.id, sourceSha256: member.sha256, snapshotRef: `registry-document-member:${member.sha256}`, presentation: "opaque-image-no-automatic-view" };
    const source = `${folder}/${member.id}.md`, companion = `${folder}/${member.id}.html`;
    const { html } = renderMarkdown(bytes, join(artifactRoot, source));
    if (html.length > DOCUMENT_LIMITS.textBytes * 16) documentReject("DOCUMENT_UNAVAILABLE");
    save(source, bytes.toString("utf8")); save(companion, html.toString("utf8"));
    return { id: member.id, sourceSha256: member.sha256, source: pathToFileURL(join(artifactRoot, source)).href, html: pathToFileURL(join(artifactRoot, companion)).href, htmlSha256: digest(html), presentation: "safe-static-html" };
  });
  const manifest = { schemaVersion: "pa-document-presentation/v1", subjectSha256: sha256, renderer, members, observation: "not-performed", approval: "not-issued", okularExport: "unavailable-use-markdown-or-browser-fallback" };
  save(`${folder}/manifest.json`, JSON.stringify(manifest));
  return { ...manifest, manifest: pathToFileURL(join(artifactRoot, folder, "manifest.json")).href };
}
