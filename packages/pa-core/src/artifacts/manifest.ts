import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname } from "node:path";
import { classifyPathOperand } from "../safety-policy.js";
import {
  ARTIFACT_POLICY_VERSION, ARTIFACT_SOURCE_MAX_BYTES, artifactDiagnostic,
  assertArtifactAbsolutePath, type ArtifactDiagnostic,
} from "./policy.js";
import { ARTIFACT_RENDERER_VERSION, renderMarkdown } from "./render.js";

export interface ArtifactAnchor { id: string; startLine: number; endLine: number }
export interface ArtifactManifest {
  schema: "pa-artifact-manifest/v1";
  sourceRef: string;
  sourceSha256: string;
  htmlSha256: string;
  rendererVersion: string;
  policyVersion: string;
  anchors: ArtifactAnchor[];
}
export interface ArtifactIdentity {
  sourceRef: string;
  sourceSha256: string;
  htmlSha256: string;
  manifestSha256: string;
  rendererVersion: string;
  policyVersion: string;
}
export interface ValidatedArtifact {
  manifest: ArtifactManifest;
  identity: ArtifactIdentity;
  source: Buffer;
  html: Buffer;
  manifestBytes: Buffer;
}

export function artifactSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** v1 canonical JSON: this exact field order, two-space indentation, LF final
 * newline, JSON.stringify escaping, UTF-8 without BOM. No ambient formatting. */
export function serializeArtifactManifest(manifest: ArtifactManifest): Buffer {
  return Buffer.from(`${JSON.stringify({
    schema: manifest.schema, sourceRef: manifest.sourceRef,
    sourceSha256: manifest.sourceSha256, htmlSha256: manifest.htmlSha256,
    rendererVersion: manifest.rendererVersion, policyVersion: manifest.policyVersion,
    anchors: manifest.anchors.map(({ id, startLine, endLine }) => ({ id, startLine, endLine })),
  }, null, 2)}\n`, "utf8");
}

export function decodeArtifactSource(bytes: Uint8Array): string {
  if (bytes.byteLength > ARTIFACT_SOURCE_MAX_BYTES) throw artifactDiagnostic("ARTIFACT_SOURCE_INVALID");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw artifactDiagnostic("ARTIFACT_SOURCE_INVALID"); }
}

/** Linux fd-relative traversal: no ancestor or final symlink is followed, and
 * the directory remains pinned even if a pathname is concurrently replaced. */
export function openArtifactDirectory(path: string, diagnostic: ArtifactDiagnostic): number {
  let fd: number | undefined;
  try {
    if (process.platform !== "linux") throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
    if (path !== "/") assertArtifactAbsolutePath(path);
    if (!classifyPathOperand(path).allowed) throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
    fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const part of path.split("/").filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd);
      fd = next;
    }
    if (realpathSync(`/proc/self/fd/${fd}`) !== path) throw artifactDiagnostic(diagnostic);
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof Error && error.name === "ArtifactPolicyError") throw error;
    throw artifactDiagnostic(diagnostic);
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export function readArtifactFile(path: string, maxBytes: number, diagnostic: ArtifactDiagnostic): Buffer {
  assertArtifactAbsolutePath(path);
  if (!classifyPathOperand(path).allowed) throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
  const parent = openArtifactDirectory(dirname(path), diagnostic);
  try { return readArtifactFileAt(parent, basename(path), maxBytes, diagnostic); }
  finally { closeSync(parent); }
}

export function readArtifactFileAt(parent: number, name: string, maxBytes: number, diagnostic: ArtifactDiagnostic): Buffer {
  if (!name || name === "." || name === ".." || /[\/\\\u0000]/.test(name)) throw artifactDiagnostic(diagnostic);
  let fd: number | undefined;
  try {
    // NONBLOCK prevents a hostile FIFO from hanging before fstat can reject it.
    fd = openSync(`/proc/self/fd/${parent}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw artifactDiagnostic(diagnostic);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length !== Number(before.size) || !sameFile(before, fstatSync(fd, { bigint: true }))) throw artifactDiagnostic(diagnostic);
    return bytes.subarray(0, length);
  } catch { throw artifactDiagnostic(diagnostic); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function parseManifest(bytes: Buffer): ArtifactManifest {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const m = value as Record<string, unknown>;
    if (Object.keys(m).length !== 7 || m["schema"] !== "pa-artifact-manifest/v1"
        || typeof m["sourceRef"] !== "string" || typeof m["sourceSha256"] !== "string"
        || !/^[a-f0-9]{64}$/.test(m["sourceSha256"]) || typeof m["htmlSha256"] !== "string"
        || !/^[a-f0-9]{64}$/.test(m["htmlSha256"]) || m["rendererVersion"] !== ARTIFACT_RENDERER_VERSION
        || m["policyVersion"] !== ARTIFACT_POLICY_VERSION || !Array.isArray(m["anchors"])) throw new Error();
    assertArtifactAbsolutePath(m["sourceRef"]);
    let lastEnd = 0;
    for (const entry of m["anchors"] as unknown[]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error();
      const a = entry as Record<string, unknown>;
      if (Object.keys(a).length !== 3 || typeof a["startLine"] !== "number" || typeof a["endLine"] !== "number"
          || !Number.isSafeInteger(a["startLine"]) || !Number.isSafeInteger(a["endLine"])
          || a["startLine"] <= lastEnd || a["endLine"] < a["startLine"]
          || a["id"] !== `source-L${a["startLine"]}-L${a["endLine"]}`) throw new Error();
      lastEnd = a["endLine"];
    }
    const manifest = value as ArtifactManifest;
    if (!serializeArtifactManifest(manifest).equals(bytes)) throw new Error();
    return manifest;
  } catch { throw artifactDiagnostic("ARTIFACT_STALE"); }
}

/** Reusable phase-3 validator. Verifies, never repairs or writes. In-memory
 * derivation checks bind anchors and HTML to source; expected pins a session's
 * exact original manifest as well. No stale bytes are relabeled or published. */
export function validateArtifactManifest(path: string, expected?: ArtifactIdentity): ValidatedArtifact {
  assertArtifactAbsolutePath(path);
  if (basename(path) !== "manifest.json") throw artifactDiagnostic("ARTIFACT_USAGE_INVALID");
  const parent = openArtifactDirectory(dirname(path), "ARTIFACT_STALE");
  try {
    // Worst-case per-line anchors/HTML expand Markdown; still bound every read.
    const maxCompanionBytes = ARTIFACT_SOURCE_MAX_BYTES * 128;
    const manifestBytes = readArtifactFileAt(parent, "manifest.json", maxCompanionBytes, "ARTIFACT_STALE");
    const manifest = parseManifest(manifestBytes);
    const identity: ArtifactIdentity = {
      sourceRef: manifest.sourceRef, sourceSha256: manifest.sourceSha256,
      htmlSha256: manifest.htmlSha256, manifestSha256: artifactSha256(manifestBytes),
      rendererVersion: manifest.rendererVersion, policyVersion: manifest.policyVersion,
    };
    if (expected && (Object.keys(identity) as (keyof ArtifactIdentity)[]).some((key) => identity[key] !== expected[key])) {
      throw artifactDiagnostic("ARTIFACT_STALE");
    }
    const source = readArtifactFile(manifest.sourceRef, ARTIFACT_SOURCE_MAX_BYTES, "ARTIFACT_STALE");
    const html = readArtifactFileAt(parent, "index.html", maxCompanionBytes, "ARTIFACT_STALE");
    if (artifactSha256(source) !== manifest.sourceSha256 || artifactSha256(html) !== manifest.htmlSha256) throw artifactDiagnostic("ARTIFACT_STALE");
    let derived: ReturnType<typeof renderMarkdown>;
    try { derived = renderMarkdown(source, manifest.sourceRef); }
    catch { throw artifactDiagnostic("ARTIFACT_STALE"); }
    if (!derived.html.equals(html) || JSON.stringify(derived.anchors) !== JSON.stringify(manifest.anchors)) throw artifactDiagnostic("ARTIFACT_STALE");
    // Re-read pinned files to reject mutation during derivation, not just before it.
    if (!manifestBytes.equals(readArtifactFileAt(parent, "manifest.json", maxCompanionBytes, "ARTIFACT_STALE"))
        || !html.equals(readArtifactFileAt(parent, "index.html", maxCompanionBytes, "ARTIFACT_STALE"))
        || !source.equals(readArtifactFile(manifest.sourceRef, ARTIFACT_SOURCE_MAX_BYTES, "ARTIFACT_STALE"))
        || realpathSync(`/proc/self/fd/${parent}`) !== dirname(path)) throw artifactDiagnostic("ARTIFACT_STALE");
    return { manifest, identity, source, html, manifestBytes };
  } catch {
    // Once inspecting a companion, every malformed/tampered identity (including
    // a sourceRef redirected to a forbidden path) is stale, never a new source.
    throw artifactDiagnostic("ARTIFACT_STALE");
  } finally { closeSync(parent); }
}
