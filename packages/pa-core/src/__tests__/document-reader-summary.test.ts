import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { renderPackageMarkdown } from "../artifacts/render.js";
import { documentPackageSha, type DocumentMember, type DocumentPackage } from "../documents/package-contract.js";
import { renderDocumentReader, type DocumentReaderBundle } from "../documents/reader.js";
import { renderDocumentReaderInWorker } from "../documents/reader-worker-owner.js";
import { digest } from "../workflows/contracts.js";

function fixture() {
  const sources = new Map<string, Buffer>(), base = "agent-teams/requirements/artifacts/reviews/EX-1/r001";
  const member = (id: string, role: DocumentMember["role"], mediaType: DocumentMember["mediaType"], path: string, content: string | Buffer): DocumentMember => {
    const bytes = Buffer.from(content), sha256 = digest(bytes); sources.set(sha256, bytes);
    return { id, role, mediaType, source: `${base}/${path}`, description: `${id} \"quoted\" <literal> & complete`, bytes: bytes.length, sha256 };
  };
  const brief = member("decision-overview", "brief", "text/markdown", "overview.md", "# Decision\n\nEXECUTIVE_START\n\n[Requirements](nested/requirements.md) [Self](./overview.md)\n\n## Rationale\n\nEXECUTIVE_END\n");
  const members = [
    member("requirements", "requirements", "text/markdown", "nested/requirements.md", `# Requirements\n\nREQUIREMENTS_START\n\n[Summary](../overview.md) [UAT](acceptance.md) [By root](${base}/overview.md) [Notes](../notes.txt) [Diagram](../diagram.png)\n\n| Key | Value |\n| --- | --- |\n| long | ${"wide".repeat(300)} |\n\n\`\`\`text\n${"code".repeat(300)}\n\`\`\`\n\nREQUIREMENTS_END\n`),
    member("notes", "specification", "text/plain", "notes.txt", "PLAIN_START\nLiteral <img src=x onerror=alert(1)> & quotes \"\n\nPLAIN_END\n"),
    member("acceptance", "uat", "text/markdown", "nested/acceptance.md", "# Cases\n\nUAT_START\n\n[Requirements](requirements.md)\n\n# Cases\n\nUAT_END\n"),
    member("diagram", "specification", "image/png", "diagram.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64")),
    member("photo", "specification", "image/jpeg", "photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])),
    brief,
  ];
  const subject: DocumentPackage = {
    schemaVersion: "pa-document-package/v1", packageId: "reader-summary", revision: 1, repository: { key: "example", root: "/tmp/reader-summary-repo" }, ticket: "EX-1", predecessor: null,
    members, effects: { publish: true, queue: false, route: { team: "builder", mode: "orchestrator" } },
    references: [{ locator: "https://example.invalid/<literal>", version: "not fetched", description: "Informative only" }],
  };
  const snapshot = (sha256: string) => { const bytes = sources.get(sha256); assert.ok(bytes, "fixture source exists"); return bytes; };
  return { subject, brief, sources, snapshot, render: () => renderDocumentReader(subject, snapshot) };
}

/** Static inventory/link validation, not a DOM, browser or accessibility observation. */
function checkLinks(bundle: DocumentReaderBundle): void {
  const ids = new Map<string, Set<string>>();
  for (const [path, bytes] of bundle.files) {
    if (!path.endsWith(".html")) continue;
    const html = bytes.toString(), found = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!);
    assert.equal(new Set(found).size, found.length, `${path}: unique IDs`);
    ids.set(path, new Set(found));
  }
  for (const [path, ownIds] of ids) {
    const html = bundle.files.get(path)!.toString();
    for (const [, target] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(target!, `file:///bundle/${path}`);
      assert.equal(url.protocol, "file:", `${path}: local-only ${target}`);
      assert.ok(url.pathname.startsWith("/bundle/"), `${path}: within bundle ${target}`);
      const targetPath = url.pathname.slice("/bundle/".length);
      assert.ok(bundle.files.has(targetPath), `${path}: complete file ${target}`);
      if (url.hash) assert.ok(ids.get(targetPath)?.has(url.hash.slice(1)), `${path}: complete anchor ${target}`);
    }
    for (const [, labels] of html.matchAll(/aria-labelledby="([^"]+)"/g)) {
      for (const label of labels!.split(" ")) assert.ok(ownIds.has(label), `${path}: label ${label}`);
    }
  }
}

test("executive entry contains the complete role-selected brief before the unchanged manifest-order full view at every brief position", () => {
  const f = fixture(), others = f.subject.members.filter(member => member.role !== "brief");
  for (let position = 0; position <= others.length; position++) {
    const peers = position % 2 ? [...others].reverse() : others;
    f.subject.members = [...peers.slice(0, position), f.brief, ...peers.slice(position)];
    const bundle = f.render(), html = bundle.files.get("index.html")!.toString();
    const summaryStart = html.indexOf('<section class="member" id="executive-summary"'), completeStart = html.indexOf('<div id="complete-view">');
    assert.ok(summaryStart > html.indexOf('<main id="documents">'));
    assert.ok(summaryStart < html.indexOf("EXECUTIVE_START") && html.indexOf("EXECUTIVE_END") < completeStart);
    const aliases = new Map([["nested/requirements.md", `#member-${f.subject.members.findIndex(member => member.role === "requirements") + 1}`], ["./overview.md", `#member-${position + 1}`]]);
    const full = html.slice(completeStart), expected = renderPackageMarkdown(f.snapshot(f.brief.sha256), `member-${position + 1}`, aliases).html;
    assert.ok(html.slice(summaryStart, completeStart).includes(expected.replace(/id="(member-[0-9]+-section-[0-9]+)"/g, 'id="executive-$1"')), "entire brief body, not an excerpt");
    assert.deepEqual([...full.matchAll(/<article class="member" id="member-([0-9]+)"/g)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(bundle.manifest.members.map(member => member.id), f.subject.members.map(member => member.id));
    assert.equal(bundle.manifest.subjectSha256, documentPackageSha(f.subject));
    for (const marker of ["EXECUTIVE_START", "EXECUTIVE_END", "REQUIREMENTS_START", "REQUIREMENTS_END", "PLAIN_START", "PLAIN_END", "UAT_START", "UAT_END"]) assert.ok(full.includes(marker), marker);
    checkLinks(bundle);
  }
});

test("built worker delivers the summary-first entry with the original arbitrary inventory and complete local links", async () => {
  const f = fixture(), bundle = await renderDocumentReaderInWorker(f.subject, f.snapshot), html = bundle.files.get("index.html")!.toString();
  assert.match(html, /<main id="documents"><section class="member" id="executive-summary"/);
  assert.ok(html.indexOf("EXECUTIVE_END") < html.indexOf('<div id="complete-view">'));
  assert.deepEqual(bundle.manifest.members.map(member => member.id), f.subject.members.map(member => member.id));
  assert.equal(bundle.manifest.members.at(-1)!.role, "brief");
  checkLinks(bundle);
});

test("entry inventory explicitly links every complete member page and exact raw source without reordering or renaming outputs", () => {
  const f = fixture(), bundle = f.render(), html = bundle.files.get("index.html")!.toString();
  const toc = html.match(/<nav aria-label="Package contents">(.*?)<\/nav>/s)?.[1]; assert.ok(toc);
  assert.ok(toc.indexOf('href="#executive-summary"') < toc.indexOf('href="#member-1"'));
  for (const [i, member] of bundle.manifest.members.entries()) {
    const source = f.subject.members[i]!;
    assert.deepEqual(member, { id: source.id, role: source.role, mediaType: source.mediaType, description: source.description, bytes: source.bytes, sha256: source.sha256,
      raw: `raw/member-${i + 1}.${source.mediaType === "text/markdown" ? "md" : source.mediaType === "text/plain" ? "txt" : source.mediaType === "image/png" ? "png" : "jpg"}`, companion: `members/member-${i + 1}.html` });
    assert.ok(toc.includes(`href="${member.companion}"`)); assert.ok(toc.includes(`href="${member.raw}"`));
    assert.deepEqual(bundle.files.get(member.raw), f.snapshot(member.sha256));
    assert.equal(digest(bundle.files.get(member.raw)!), member.sha256);
    assert.equal(bundle.files.get(member.raw)!.length, member.bytes);
    const page = bundle.files.get(member.companion)!.toString();
    assert.ok(page.includes(`href="../${member.raw}"`));
    if (source.mediaType.startsWith("text/")) {
      const marker = source.role === "brief" ? "EXECUTIVE" : source.role === "requirements" ? "REQUIREMENTS" : source.role === "uat" ? "UAT" : "PLAIN";
      assert.ok(page.includes(`${marker}_START`) && page.includes(`${marker}_END`), "member body complete");
    } else assert.ok(page.includes(`src="../${member.raw}" alt="`));
  }
  assert.equal(bundle.files.size, f.subject.members.length * 2 + 2);
  assert.ok(html.includes('href="manifest.json"'));
  checkLinks(bundle);
});

test("member pages have real previous/next siblings, back/skip links and local cross-document aliases", () => {
  const bundle = fixture().render();
  for (const [index, member] of bundle.manifest.members.entries()) {
    const html = bundle.files.get(member.companion)!.toString();
    assert.match(html, /<a class="skip" href="#document">Skip to document<\/a>/);
    assert.match(html, /href="\.\.\/index.html#contents">Back to contents<\/a>/);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    if (index) assert.ok(html.includes(`href="member-${index}.html#member-${index}">Previous:`));
    else assert.doesNotMatch(html, />Previous:/);
    if (index + 1 < bundle.manifest.members.length) assert.ok(html.includes(`href="member-${index + 2}.html#member-${index + 2}">Next:`));
    else assert.doesNotMatch(html, />Next:/);
    assert.doesNotMatch(html, /href="\.\.\/index.html"/);
  }
  const requirements = bundle.files.get("members/member-1.html")!.toString(), brief = bundle.files.get("members/member-6.html")!.toString();
  for (const label of ["Summary", "By root"]) assert.ok(requirements.includes(`href="member-6.html#member-6" rel="noreferrer">${label}</a>`));
  assert.match(requirements, /href="member-3.html#member-3" rel="noreferrer">UAT<\/a>/);
  assert.match(brief, /href="member-1.html#member-1" rel="noreferrer">Requirements<\/a>/);
  assert.match(brief, /href="#member-6" rel="noreferrer">Self<\/a>/);
  checkLinks(bundle);
});

test("all HTML keeps inert hashed CSP, escaped metadata, local assets and static focus/print/overflow affordances", () => {
  const bundle = fixture().render();
  for (const [path, bytes] of bundle.files) {
    if (!path.endsWith(".html")) continue;
    const html = bytes.toString(), style = html.match(/<style>(.*?)<\/style>/s)?.[1]; assert.ok(style);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1].replace(/&#39;/g, "'"); assert.ok(csp);
    assert.ok(csp.includes(`style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'`));
    for (const directive of ["default-src", "script-src", "connect-src", "font-src", "media-src", "object-src", "frame-src", "base-uri", "form-action"]) assert.ok(csp.includes(`${directive} 'none'`), directive);
    assert.ok(csp.includes("img-src 'self'"));
    assert.doesNotMatch(html, /<(?:script|iframe|form|input|button|object|embed|svg|link|base)\b|<[^>]*\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /(?:href|src)="(?:https?:|\/\/|data:|javascript:)|@import|url\(/i);
    assert.match(html, /&quot;quoted&quot; &lt;literal&gt; &amp; complete/);
    assert.match(html, /<html lang="en">/); assert.match(html, /name="viewport"/); assert.match(html, /<main\b/);
    assert.ok(style.includes("a:focus-visible,summary:focus-visible,.local-overflow:focus-visible{outline:"));
    assert.ok(style.includes(".skip:focus{"));
    assert.ok(style.includes(".local-overflow{width:100%;max-width:100%;min-width:0;overflow:auto;"));
    assert.ok(style.includes("@media(max-width:900px){aside{display:none}header,main,footer{margin-left:0;"));
    assert.ok(style.includes("@media print{")); assert.ok(style.includes(".local-overflow{overflow:visible}"));
    assert.ok(style.includes("pre{white-space:pre-wrap;overflow-wrap:anywhere}"));
    assert.ok(style.includes("table{table-layout:fixed;width:100%}"));
  }
  const html = bundle.files.get("index.html")!.toString();
  for (const label of ["Code block", "Data table"]) assert.ok(html.includes(`class="local-overflow" tabindex="0" role="region" aria-label="${label}"`));
  assert.match(html, /Literal &lt;img src=x onerror=alert\(1\)&gt;/);
  checkLinks(bundle);
});

test("untrusted markup and unsupported source aliases stay literal in the executive entry and member pages", () => {
  const f = fixture(), bytes = Buffer.from('# Untrusted\n\n[Remote](https://example.invalid) [Protocol relative](//example.invalid) [Encoded](%6aavascript:evil) [Missing](missing.md) [Fragment](#member-1)\n\n<img src=x onerror=alert(1)>\n\n<form action="https://example.invalid"><input></form>\n\n<style>body{background:url(https://example.invalid)}</style>\n');
  f.brief.bytes = bytes.length; f.brief.sha256 = digest(bytes); f.sources.set(f.brief.sha256, bytes);
  const bundle = f.render();
  for (const path of ["index.html", "members/member-6.html"]) {
    const html = bundle.files.get(path)!.toString();
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(html, /&lt;form action=/);
    assert.match(html, /\[Missing\]\(missing.md\)/); assert.match(html, /\[Fragment\]\(#member-1\)/);
    assert.doesNotMatch(html, /<(?:img|form|input)\b[^>]*(?:onerror|action)|href="(?:https?:|\/\/|%6a|missing)/i);
    assert.equal((html.match(/<style>/g) ?? []).length, 1, "only the packaged stylesheet is active");
  }
  checkLinks(bundle);
});

test("text/plain brief is also complete and summary-first without activating literal markup or links", () => {
  const f = fixture(), bytes = Buffer.from("PLAIN_BRIEF_START\n<img src=x>\n\n[Not an active link](https://example.invalid)\nPLAIN_BRIEF_END\n");
  Object.assign(f.brief, { mediaType: "text/plain", source: f.brief.source.replace(/\.md$/, ".txt"), bytes: bytes.length, sha256: digest(bytes) });
  f.sources.set(digest(bytes), bytes);
  const bundle = f.render(), html = bundle.files.get("index.html")!.toString(), summary = html.slice(html.indexOf('id="executive-summary"'), html.indexOf('<div id="complete-view">'));
  assert.ok(summary.includes("PLAIN_BRIEF_START") && summary.includes("PLAIN_BRIEF_END"));
  assert.match(summary, /&lt;img src=x&gt;/); assert.doesNotMatch(summary, /<img\b|href="https?:/);
  assert.equal(bundle.manifest.members.at(-1)!.raw, "raw/member-6.txt");
  checkLinks(bundle);
});

test("summary-first output is byte-deterministic and exactly manifest-bound; source and order changes select new identities", () => {
  const f = fixture(), first = f.render(), second = f.render();
  assert.deepEqual(first, second);
  assert.deepEqual(first.manifest.outputs.map(output => output.path), [...first.files.keys()].filter(path => path !== "manifest.json"));
  for (const output of first.manifest.outputs) {
    const bytes = first.files.get(output.path)!;
    assert.equal(output.bytes, bytes.length); assert.equal(output.sha256, digest(bytes));
  }
  assert.equal(first.manifestSha256, digest(first.files.get("manifest.json")!));
  assert.deepEqual(first.files.get("manifest.json"), Buffer.from(JSON.stringify(first.manifest, null, 2) + "\n"));
  const bytes = Buffer.from("A changed complete executive brief.\n");
  f.brief.bytes = bytes.length; f.brief.sha256 = digest(bytes); f.sources.set(f.brief.sha256, bytes);
  const changed = f.render().deliverySha256; assert.notEqual(changed, first.deliverySha256);
  [f.subject.members[0], f.subject.members[1]] = [f.subject.members[1]!, f.subject.members[0]!];
  assert.notEqual(f.render().deliverySha256, changed);
});
