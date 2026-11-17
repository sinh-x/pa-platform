import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPackageMarkdown } from "../artifacts/render.js";
import { escapeArtifactText } from "../artifacts/policy.js";
import { digest } from "../workflows/contracts.js";
import { documentPackageSha, documentReject, parseDocumentPackage, type DocumentPackage } from "./package-contract.js";
import { documentText, validateDocumentBytes } from "./package-tools.js";

/** Deterministic delivery derivation; no filesystem publication, browser launch,
 * decision or capability registration. Changed implementation bytes select a new
 * immutable delivery identity, never a migration of historical output. */
export const DOCUMENT_READER_VERSION = "pa-document-reader/v1";
export const DOCUMENT_READER_LIMITS = Object.freeze({ outputBytes: 64 * 1024 * 1024, milliseconds: 30_000 });
const STYLE = `:root{color-scheme:light;font:17px/1.6 system-ui,sans-serif;color:#172b3a;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;overflow-wrap:anywhere}a{color:#17646c;text-underline-offset:.2em}a:visited{color:#654685}a:focus-visible,summary:focus-visible,.local-overflow:focus-visible{outline:3px solid #bd5b00;outline-offset:3px}:target{scroll-margin-top:1rem;outline:2px solid #287f87}.skip{position:absolute;left:-10000px}.skip:focus{left:1rem;top:1rem;background:white;padding:1rem;z-index:2}aside{position:fixed;width:272px;inset:0 auto 0 0;overflow:auto;padding:1rem;background:#123149;color:white}aside a{color:#b7f1f4}aside a:visited{color:#e2cfff}nav ul{list-style:none;padding-left:1rem}nav>ul{padding-left:0}nav li{margin:.35rem 0}header,main,footer{margin-left:272px;padding:1.5rem;max-width:1200px}header h1{line-height:1.2}.member,.technical{background:white;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem;min-width:0}.status{font-weight:700;border-left:5px solid #287f87;padding-left:1rem}.metadata{font-size:.88rem}.member-nav{display:flex;gap:1rem;flex-wrap:wrap}.local-overflow{width:100%;max-width:100%;min-width:0;overflow:auto;margin:1rem 0}pre{white-space:pre;tab-size:2;margin:0;padding:1rem;background:#f3f6fa}code{font-family:ui-monospace,monospace}table{border-collapse:collapse;min-width:100%}th,td{border:1px solid #b9c8d2;padding:.5rem;text-align:left;vertical-align:top}img{max-width:100%;height:auto}figure{margin:1rem 0}blockquote{border-left:3px solid #287f87;padding-left:1rem;margin-left:0}.mobile-contents{display:none}@media(max-width:900px){aside{display:none}header,main,footer{margin-left:0;padding:1rem}.member,.technical{padding:1rem}.mobile-contents{display:block;background:white;border-radius:8px;padding:1rem}summary{cursor:pointer;font-weight:700}}@media print{aside,.mobile-contents,.skip,.member-nav{display:none}header,main,footer{margin:0;max-width:none;padding:0}.member,.technical{border-radius:0;padding:0;break-inside:auto}.local-overflow{overflow:visible}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{table-layout:fixed;width:100%}a{color:inherit}body{background:white}}`;
const extension = { "text/markdown": "md", "text/plain": "txt", "image/png": "png", "image/jpeg": "jpg" };

/** Hash the actual renderer, shared token/escaping implementation and parser
 * bytes, not merely their version labels. Fixed native module paths only. */
function implementationSha256(): string {
  const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const paths = [import.meta.url, new URL(`../artifacts/render.${suffix}`, import.meta.url).href,
    new URL(`../artifacts/policy.${suffix}`, import.meta.url).href,
    new URL(`./reader-worker.${suffix}`, import.meta.url).href, new URL(`./reader-worker-owner.${suffix}`, import.meta.url).href,
    import.meta.resolve("marked")];
  const hash = createHash("sha256");
  for (const path of paths) { const bytes = readFileSync(fileURLToPath(path)); hash.update(String(bytes.length)); hash.update(":"); hash.update(bytes); }
  return hash.digest("hex");
}
export interface DocumentReaderBundle {
  deliverySha256: string; manifestSha256: string; files: ReadonlyMap<string, Buffer>;
  manifest: { schemaVersion: string; deliverySha256: string; subjectSha256: string; revision: number; effects: DocumentPackage["effects"];
    renderer: { id: string; implementationSha256: string }; members: { id: string; role: string; mediaType: string; description: string; bytes: number; sha256: string; raw: string; companion: string }[];
    outputs: { path: string; sha256: string; bytes: number }[]; generationState: string; observation: string };
}
/** Full in-memory derivation. Any failure returns no partial bundle. Native
 * production publication uses reader-worker-owner for an externally enforced
 * deadline; this pure synchronous seam cannot interrupt itself. */
export function renderDocumentReader(input: DocumentPackage, snapshot: (sha256: string) => Uint8Array): DocumentReaderBundle {
  const started = performance.now(), subject = parseDocumentPackage(input), subjectSha256 = documentPackageSha(subject);
  const renderer = { id: DOCUMENT_READER_VERSION, implementationSha256: implementationSha256() };
  const members = subject.members.map((member, i) => ({ id: member.id, role: member.role, mediaType: member.mediaType, description: member.description, bytes: member.bytes,
    sha256: member.sha256, raw: `raw/member-${i + 1}.${extension[member.mediaType]}`, companion: `members/member-${i + 1}.html` }));
  // Read and verify ALL immutable bytes before deriving any advertised output.
  const sources = subject.members.map(member => { const bytes = Buffer.from(snapshot(member.sha256)); validateDocumentBytes(member, bytes); return bytes; });
  const deliverySha256 = digest(JSON.stringify({ schemaVersion: "pa-document-reader-identity/v1", subjectSha256, revision: subject.revision, effects: subject.effects, members, renderer }));
  const files = new Map<string, Buffer>(); let total = 0;
  const save = (path: string, value: string | Buffer) => {
    if (files.has(path)) documentReject("DOCUMENT_CONFLICT");
    const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
    total += bytes.length;
    if (total > DOCUMENT_READER_LIMITS.outputBytes || performance.now() - started > DOCUMENT_READER_LIMITS.milliseconds) documentReject("DOCUMENT_UNAVAILABLE");
    files.set(path, bytes);
  };
  const e = escapeArtifactText;
  const csp = `default-src 'none'; script-src 'none'; style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'; img-src 'self'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  const shell = (title: string, body: string) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${e(csp)}"><meta name="referrer" content="no-referrer"><title>${e(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>\n`;
  const articles: string[] = [], contents: string[] = [];
  let executive = "";
  const siblings = (i: number, standalone: boolean) => {
    const link = (target: number) => `${standalone ? basename(members[target]!.companion) : ""}#member-${target + 1}`;
    return `<nav class="member-nav" aria-label="Member navigation">${i ? `<a href="${link(i - 1)}">Previous: ${e(members[i - 1]!.description)}</a>` : ""}${i + 1 < members.length ? `<a href="${link(i + 1)}">Next: ${e(members[i + 1]!.description)}</a>` : ""}<a href="${standalone ? "../index.html" : ""}#contents">Back to contents</a></nav>`;
  };
  // Reserve every canonical full source path before any document-relative or
  // convenience alias. Inventory order must never retarget a canonical link.
  const canonical = new Map(subject.members.map((member, index) => [member.source, `#member-${index + 1}`]));
  members.forEach((member, index) => {
    const source = subject.members[index]!, bytes = sources[index]!, id = `member-${index + 1}`;
    save(member.raw, bytes);
    let body: string, headings: { id: string; level: number; label: string }[] = [];
    if (source.mediaType === "text/markdown") {
      const aliases = new Map(canonical), ambiguous = new Set<string>();
      const alias = (path: string, anchor: string) => {
        if (canonical.has(path) || ambiguous.has(path)) return;
        const previous = aliases.get(path);
        if (previous !== undefined && previous !== anchor) {
          aliases.delete(path); ambiguous.add(path);
        } else aliases.set(path, anchor);
      };
      subject.members.forEach((target, targetIndex) => {
        const anchor = `#member-${targetIndex + 1}`;
        alias(posix.relative(dirname(source.source), target.source), anchor);
        const name = basename(target.source);
        if (subject.members.filter(m => basename(m.source) === name).length === 1) { alias(name, anchor); alias(`./${name}`, anchor); }
      });
      ({ html: body, headings } = renderPackageMarkdown(bytes, id, aliases));
    } else if (source.mediaType === "text/plain") {
      body = documentText(bytes).split(/\n\s*\n/).map(part => `<p>${e(part).replace(/\r\n|\r|\n/g, "<br>")}</p>`).join("\n");
    } else {
      body = `<figure><img src="${member.raw}" alt="${e(member.description)}"><figcaption>${e(member.description)}</figcaption></figure>`;
    }
    const metadata = (standalone: boolean) => `<p class="metadata">Required ${e(member.role)} · ${e(member.mediaType)} · ${member.bytes} bytes<br>Source SHA-256: <code>${member.sha256}</code><br><a href="${standalone ? "../" : ""}${member.raw}">Exact raw source</a> · <a href="${standalone ? `../index.html#${id}` : member.companion}">${standalone ? "Full package reader" : "Full member page"}</a></p>`;
    const article = (content: string, standalone: boolean) => `<article class="member" id="${id}" aria-labelledby="${id}-title"><h2 id="${id}-title">${index + 1}. ${e(member.description)}</h2>${metadata(standalone)}${siblings(index, standalone)}${content}${siblings(index, standalone)}</article>`;
    articles.push(article(body, false));
    if (source.role === "brief") {
      // The executive entry is complete, not an excerpt. Keep the full view and
      // its manifest ordinals unchanged; only this duplicate's heading IDs differ.
      const summaryBody = body.replace(/id="(member-[0-9]+-section-[0-9]+)"/g, 'id="executive-$1"');
      executive = `<section class="member" id="executive-summary" aria-labelledby="executive-title"><h2 id="executive-title">Executive summary — ${e(member.description)}</h2>${metadata(false)}${summaryBody}<p><a href="#complete-view">Read the complete package in manifest order</a></p></section>`;
    }
    // Build genuine nested section navigation; generated IDs never use user slugs.
    interface NavNode { id: string; label: string; children: NavNode[] }
    const tree: NavNode[] = [];
    const stack: { level: number; children: typeof tree }[] = [{ level: 2, children: tree }];
    for (const heading of headings) {
      while (stack.length > 1 && stack.at(-1)!.level >= heading.level) stack.pop();
      const node = { id: heading.id, label: heading.label, children: [] as typeof tree };
      stack.at(-1)!.children.push(node); stack.push({ level: heading.level, children: node.children });
    }
    const list = (nodes: typeof tree): string => nodes.length ? `<ul>${nodes.map(node => `<li><a href="#${node.id}">${e(node.label)}</a>${list(node.children)}</li>`).join("")}</ul>` : "";
    contents.push(`<li><a href="#${id}">${index + 1}. ${e(member.description)}</a> · <a href="${member.companion}">Full member page</a> · <a href="${member.raw}">Exact raw source</a>${list(tree)}</li>`);
    // Only generated, allowlisted anchors leave the Markdown renderer. Convert
    // those to genuine sibling-page links, never user paths or index aliases.
    const standaloneBody = source.mediaType.startsWith("image/")
      ? `<figure><img src="../${member.raw}" alt="${e(member.description)}"><figcaption>${e(member.description)}</figcaption></figure>`
      : body.replace(/href="#(member-([1-9][0-9]*)(?:-section-[1-9][0-9]*)?)"/g,
        (_match, anchor: string, ordinal: string) => `href="${Number(ordinal) === index + 1 ? "" : `member-${ordinal}.html`}#${anchor}"`);
    save(member.companion, shell(member.description, `<a class="skip" href="#document">Skip to document</a><header><h1>${e(member.description)}</h1><p class="status">UNAPPROVED-at-generation. Opening is not approval.</p><a href="../index.html#${id}">Full package reader</a></header><main id="document">${article(standaloneBody, true)}</main>`));
  });
  const toc = `<nav aria-label="Package contents"><ul><li><a href="#executive-summary">Executive summary</a></li><li><a href="#complete-view">Complete package view</a></li>${contents.join("")}</ul></nav>`;
  const technical = `<section class="technical" aria-labelledby="technical-title"><h2 id="technical-title">Technical identity</h2><p>Subject SHA-256: <code>${subjectSha256}</code><br>Delivery SHA-256: <code>${deliverySha256}</code><br>Renderer: ${renderer.id}<br>Renderer implementation SHA-256: <code>${renderer.implementationSha256}</code></p><p>Proposed effects (not authority): publication ${subject.effects.publish ? "yes" : "no"}, queue ${subject.effects.queue ? "yes" : "no"}. No branch or launch authority is issued by this reader.</p><h3>Informative references — outside required membership</h3><ul>${subject.references.map(ref => `<li>${e(ref.description)}: ${e(ref.locator)} (${e(ref.version)})</li>`).join("")}</ul><a href="manifest.json">Exact output manifest</a></section>`;
  save("index.html", shell(`${subject.ticket} ${subject.packageId} r${subject.revision}`, `<a class="skip" href="#documents">Skip to documents</a><aside aria-label="Desktop contents">${toc}</aside><header id="contents"><h1>${e(subject.ticket)} — ${e(subject.packageId)} · revision ${subject.revision}</h1><p class="status">UNAPPROVED-at-generation. This immutable snapshot is not live approval, viewing evidence or product acceptance.</p><details class="mobile-contents"><summary>Contents</summary>${toc}</details></header><main id="documents">${executive}<div id="complete-view"><p class="status">Complete package view — every required member in manifest order. Use browser find or print to review all content offline.</p>${articles.join("\n")}</div>${technical}</main><footer>Complete offline reader. Browser find and print cover every required member. No scripts or remote resources.</footer>`));
  const manifest: DocumentReaderBundle["manifest"] = { schemaVersion: DOCUMENT_READER_VERSION, deliverySha256, subjectSha256, revision: subject.revision, effects: subject.effects, renderer, members,
    outputs: [...files].map(([path, bytes]) => ({ path, sha256: digest(bytes), bytes: bytes.length })), generationState: "UNAPPROVED-at-generation", observation: "not-performed" };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  save("manifest.json", manifestBytes);
  return { deliverySha256, manifestSha256: digest(manifestBytes), files, manifest };
}
