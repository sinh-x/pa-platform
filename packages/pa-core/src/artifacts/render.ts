import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdtempSync,
  openSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Lexer, type MarkedToken, type Token } from "marked";
import { classifyOutputTarget, classifyPathOperand } from "../safety-policy.js";
import {
  ARTIFACT_POLICY_VERSION, ARTIFACT_SOURCE_MAX_BYTES, ARTIFACT_STYLE,
  artifactDiagnostic, assertArtifactAbsolutePath, assertArtifactEnvironment,
  escapeArtifactText, ArtifactPolicyError,
} from "./policy.js";
import {
  artifactSha256, decodeArtifactSource, openArtifactDirectory, readArtifactFile,
  serializeArtifactManifest, type ArtifactAnchor, type ArtifactManifest,
} from "./manifest.js";

/** Bump for any byte-affecting parsing, allowlist, presentation or anchor change.
 * marked 18.0.2 is lock-bound; parser upgrades require a renderer-version bump. */
export const ARTIFACT_RENDERER_VERSION = "pa-artifact-renderer/v1";

// No marked HTML output is trusted. Only these fixed tags are emitted, with
// escaped text and locally computed attributes. Unknown constructs stay text.
function inline(tokens: Token[]): string {
  return tokens.map((input) => {
    const token = input as MarkedToken;
    switch (token.type) {
      case "strong": return `<strong>${inline(token.tokens)}</strong>`;
      case "em": return `<em>${inline(token.tokens)}</em>`;
      case "codespan": return `<code>${escapeArtifactText(token.text)}</code>`;
      case "br": return "<br>";
      case "escape": return escapeArtifactText(token.text);
      case "text": return token.tokens ? inline(token.tokens) : escapeArtifactText(token.text);
      // Links, images, HTML, math and all unsupported syntax are inert literal
      // text, never href/src/style/DOM markup. Even fragment links stay inert.
      default: return escapeArtifactText(input.raw);
    }
  }).join("");
}

function block(input: Token): string {
  const token = input as MarkedToken;
  switch (token.type) {
    case "space": return "";
    case "heading": return `<h${token.depth}>${inline(token.tokens)}</h${token.depth}>`;
    case "paragraph": return `<p>${inline(token.tokens)}</p>`;
    case "text": return token.tokens ? inline(token.tokens) : escapeArtifactText(token.text);
    case "code": return `<pre><code>${escapeArtifactText(token.text)}</code></pre>`;
    case "list": {
      const tag = token.ordered ? "ol" : "ul";
      const start = token.ordered && Number.isSafeInteger(token.start) ? ` start="${token.start}"` : "";
      return `<${tag}${start}>${token.items.map((item) => `<li>${item.task ? (item.checked ? "[x] " : "[ ] ") : ""}${item.tokens.map(block).join("")}</li>`).join("")}</${tag}>`;
    }
    case "table": return `<table><thead><tr>${token.header.map((cell) => `<th>${inline(cell.tokens)}</th>`).join("")}</tr></thead><tbody>${token.rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell.tokens)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    default: return `<pre>${escapeArtifactText(input.raw)}</pre>`;
  }
}

/** Pure deterministic derivation; source raw bytes remain authoritative. Anchors
 * cover each nonblank top-level block, including all nested content. Lines are
 * 1-based inclusive, CRLF/lone CR count as one newline, trailing blanks excluded.
 * A fresh Lexer prevents process-global marked extensions from changing output. */
export function renderMarkdown(source: Uint8Array, sourceRef: string): { html: Buffer; anchors: ArtifactAnchor[] } {
  assertArtifactAbsolutePath(sourceRef);
  const markdown = decodeArtifactSource(source).replace(/\r\n|\r/g, "\n");
  const tokens = new Lexer({ gfm: true, breaks: false, pedantic: false }).lex(markdown);
  const anchors: ArtifactAnchor[] = [];
  let offset = 0;
  let line = 1;
  const content: string[] = [];
  function append(raw: string, rendered: string): void {
    const startLine = line;
    offset += raw.length;
    line += (raw.match(/\n/g) ?? []).length;
    if (!raw.trim()) return;
    const endLine = startLine + (raw.replace(/\n+$/, "").match(/\n/g) ?? []).length;
    const id = `source-L${startLine}-L${endLine}`;
    anchors.push({ id, startLine, endLine });
    content.push(`<section id="${id}" data-source-start="${startLine}" data-source-end="${endLine}">${rendered}</section>`);
  }
  for (const token of tokens) {
    // marked may omit duplicate link definitions. Preserve such unsupported
    // gaps as literal source, never lose text or guess a heading's source line.
    const position = markdown.indexOf(token.raw, offset);
    if (position < offset || !token.raw) throw artifactDiagnostic("ARTIFACT_SOURCE_INVALID");
    if (position > offset) {
      const gap = markdown.slice(offset, position);
      append(gap, `<pre>${escapeArtifactText(gap)}</pre>`);
    }
    append(token.raw, block(token));
  }
  if (offset < markdown.length) {
    const gap = markdown.slice(offset);
    append(gap, `<pre>${escapeArtifactText(gap)}</pre>`);
  }
  const styleHash = createHash("sha256").update(ARTIFACT_STYLE).digest("base64");
  const csp = `default-src 'none'; script-src 'none'; style-src 'sha256-${styleHash}'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'`;
  const html = Buffer.from(`<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeArtifactText(csp)}"><meta name="referrer" content="no-referrer"><title>Markdown companion</title><style>${ARTIFACT_STYLE}</style></head><body><aside class="authority">Companion only. Authoritative Markdown: <code>${escapeArtifactText(sourceRef)}</code>. Feedback is not approval.</aside><main>${content.join("\n")}</main></body></html>\n`, "utf8");
  return { html, anchors };
}

/** Existing declared coreutils runtime, never a shell, user helper, download or
 * Lavish binary. Installed wrappers prepend this dependency. GNU mv's no-copy
 * + none-fail uses Linux no-replace publication and refuses conflicting output.
 * Unsupported tools/platforms fail closed; there is no copy/Node-rename fallback. */
function atomicMoveExecutable(env: Readonly<NodeJS.ProcessEnv>): string {
  for (const directory of (env.PATH ?? "").split(":")) {
    if (!/^\/nix\/store\/[a-z0-9]{32}-coreutils[^/]*\/bin$/.test(directory)) continue;
    try {
      const executable = realpathSync(join(directory, "mv"));
      const info = statSync(executable);
      if (!/^\/nix\/store\/[a-z0-9]{32}-coreutils[^/]*\/bin\/(mv|coreutils)$/.test(executable)
          || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) continue;
      // Nix can use the immutable multicall coreutils binary. Preserve mv's
      // argv[0] rather than invoking the resolved binary without its applet.
      return join(directory, "mv");
    } catch { /* try another declared immutable coreutils path */ }
  }
  throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
}

function absentAt(parent: number, name: string): void {
  try { lstatSync(`/proc/self/fd/${parent}/${name}`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
  }
  throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
}

interface FileIdentity { dev: number; ino: number }
function writePrivate(path: string, bytes: Buffer, created: (identity: FileIdentity) => void): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    created(fstatSync(fd));
    fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export interface RenderArtifactResult {
  sourceRef: string;
  outputDir: string;
  manifest: string;
  sourceSha256: string;
  htmlSha256: string;
  manifestSha256: string;
  rendererVersion: string;
  policyVersion: string;
}

export function renderArtifact(sourceRef: string, outputDir: string, env: Readonly<NodeJS.ProcessEnv> = process.env): RenderArtifactResult {
  assertArtifactEnvironment(env);
  assertArtifactAbsolutePath(sourceRef);
  assertArtifactAbsolutePath(outputDir);
  // Reuse the existing safety boundary; do not add an env/CLI root override.
  // Caller mode restrictions still apply; this API grants no new write root.
  if (!classifyOutputTarget(outputDir, { env: { TMPDIR: env.TMPDIR } }).allowed || !classifyPathOperand(sourceRef).allowed) {
    throw artifactDiagnostic("ARTIFACT_POLICY_REJECTED");
  }
  if (sourceRef === outputDir || sourceRef.startsWith(`${outputDir}/`) || outputDir.startsWith(`${sourceRef}/`)) {
    throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
  }
  const source = readArtifactFile(sourceRef, ARTIFACT_SOURCE_MAX_BYTES, "ARTIFACT_SOURCE_INVALID");
  const { html, anchors } = renderMarkdown(source, sourceRef);
  const manifest: ArtifactManifest = {
    schema: "pa-artifact-manifest/v1", sourceRef, sourceSha256: artifactSha256(source),
    htmlSha256: artifactSha256(html), rendererVersion: ARTIFACT_RENDERER_VERSION,
    policyVersion: ARTIFACT_POLICY_VERSION, anchors,
  };
  const manifestBytes = serializeArtifactManifest(manifest);
  const mover = atomicMoveExecutable(env);
  const parent = openArtifactDirectory(dirname(outputDir), "ARTIFACT_OUTPUT_CONFLICT");
  let temporary: string | undefined;
  let temporaryFd: number | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  const ownFiles = new Map<string, FileIdentity>();
  let published = false;
  try {
    const name = basename(outputDir);
    absentAt(parent, name);
    const parentPath = `/proc/self/fd/${parent}`;
    temporary = mkdtempSync(`${parentPath}/.pa-artifact-`);
    temporaryIdentity = lstatSync(temporary);
    chmodSync(temporary, 0o700);
    temporaryFd = openSync(temporary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(temporaryFd);
    if (opened.dev !== temporaryIdentity.dev || opened.ino !== temporaryIdentity.ino) throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
    const tempPath = `/proc/self/fd/${temporaryFd}`;
    writePrivate(`${tempPath}/index.html`, html, (identity) => ownFiles.set("index.html", identity));
    writePrivate(`${tempPath}/manifest.json`, manifestBytes, (identity) => ownFiles.set("manifest.json", identity));
    fsyncSync(temporaryFd);
    if (!source.equals(readArtifactFile(sourceRef, ARTIFACT_SOURCE_MAX_BYTES, "ARTIFACT_STALE"))) throw artifactDiagnostic("ARTIFACT_STALE");
    if (realpathSync(parentPath) !== dirname(outputDir)) throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
    absentAt(parent, name);
    const result = spawnSync(mover, ["--no-copy", "--update=none-fail", "--no-target-directory", "--", `/proc/self/fd/3/${basename(temporary)}`, `/proc/self/fd/3/${name}`], {
      env: { LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", parent], timeout: 5000, maxBuffer: 4096,
    });
    if (result.status !== 0 || result.error) {
      absentAt(parent, name); // A raced destination is always output conflict.
      throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
    }
    published = true; // From here never remove anything, even if durability fails.
    const output = lstatSync(`${parentPath}/${name}`);
    const own = fstatSync(temporaryFd);
    if (!output.isDirectory() || output.ino !== own.ino || output.dev !== own.dev) throw artifactDiagnostic("ARTIFACT_OUTPUT_CONFLICT");
    fsyncSync(parent);
    return {
      sourceRef, outputDir, manifest: `${outputDir}/manifest.json`, sourceSha256: manifest.sourceSha256,
      htmlSha256: manifest.htmlSha256, manifestSha256: artifactSha256(manifestBytes),
      rendererVersion: manifest.rendererVersion, policyVersion: manifest.policyVersion,
    };
  } catch (error) {
    if (error instanceof ArtifactPolicyError) throw error;
    throw artifactDiagnostic("ARTIFACT_RUNTIME_FAILED");
  } finally {
    if (!published && temporary !== undefined && temporaryIdentity !== undefined) {
      // Exact inode-bound own entries only; never recursive cleanup or a guessed
      // destination. Unexpected replacements are preserved, not followed/deleted.
      let stillOwn = false;
      try { const current = lstatSync(temporary); stillOwn = current.ino === temporaryIdentity.ino && current.dev === temporaryIdentity.dev && current.isDirectory(); } catch { /* already absent */ }
      if (stillOwn) {
        if (temporaryFd !== undefined) for (const [file, own] of ownFiles) {
          const path = `/proc/self/fd/${temporaryFd}/${file}`;
          try {
            const current = lstatSync(path);
            if (current.isFile() && current.ino === own.ino && current.dev === own.dev) unlinkSync(path);
          } catch { /* only unpublished own temp entries */ }
        }
        try { rmdirSync(temporary); } catch { /* preserve unexpected entries */ }
      }
    }
    if (temporaryFd !== undefined) closeSync(temporaryFd);
    closeSync(parent);
  }
}
