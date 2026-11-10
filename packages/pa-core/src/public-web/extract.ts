import { PublicWebError } from "./types.js";

/** Plain-text output only; these bytes are never used as markup or executed. */
function entities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©" };
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, token: string) => {
    if (token[0] !== "#") return named[token.toLowerCase()] ?? whole;
    const point = token[1].toLowerCase() === "x" ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "";
  });
}
export function inertText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, "")
    .replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** Conservative, linear static extraction. Not a DOM, readability engine or paywall bypass. */
export function extractPublicText(source: string, mime: string): { text: string; title?: string } {
  if (mime === "text/plain") {
    const text = inertText(source); if (!text) throw new PublicWebError("WEB_UNSUPPORTED");
    return { text };
  }
  if (mime !== "text/html") throw new PublicWebError("WEB_UNSUPPORTED");
  // Explicit common access/challenge evidence: do not present its body as an article.
  if (/\b(?:cf-chl-|g-recaptcha|h-captcha|enable javascript and cookies to continue|sign in to continue|subscribe to continue|verify you are human)\b/i.test(source)) throw new PublicWebError("WEB_UNSUPPORTED");
  const output: string[] = [], title: string[] = [];
  let position = 0, inTitle = false;
  const muted: Array<{ tag: string; depth: number }> = [];
  const rawText = new Set(["script", "style", "iframe", "noscript", "noembed", "textarea", "title", "xmp"]);
  const ignored = new Set(["script", "style", "template", "iframe", "object", "embed", "svg", "math", "form", "noscript"]);
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const blocks = new Set(["p", "div", "br", "hr", "li", "tr", "section", "article", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote"]);
  while (position < source.length) {
    const open = source.indexOf("<", position);
    const textEnd = open < 0 ? source.length : open;
    if (!muted.length) (inTitle ? title : output).push(source.slice(position, textEnd));
    if (open < 0) break;
    if (source.startsWith("<!--", open)) { const close = source.indexOf("-->", open + 4); if (close < 0) throw new PublicWebError("WEB_UNSUPPORTED"); position = close + 3; continue; }
    let end = open + 1, quote = "";
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === source.length) throw new PublicWebError("WEB_UNSUPPORTED"); // do not disguise malformed partial extraction as success
    // HTML does not permit whitespace after '<' or '</'. In particular, a
    // pseudo end tag inside active text must not end suppression early.
    const raw = source.slice(open + 1, end), match = /^(\/?)([a-z][a-z0-9:-]*)(?:[\t\n\f\r /]|$)/i.exec(raw);
    position = end + 1;
    if (!match) continue;
    const closing = Boolean(match[1]), tag = match[2].toLowerCase();
    if (tag === "plaintext") throw new PublicWebError("WEB_UNSUPPORTED"); // no reliable closing boundary
    if (tag === "input" && /\btype\s*=\s*(?:"password"|'password'|password(?:\s|\/|$))/i.test(raw)) throw new PublicWebError("WEB_UNSUPPORTED");
    const suppressed = muted.at(-1);
    if (suppressed) {
      if (tag === suppressed.tag) {
        if (closing) { if (--suppressed.depth === 0) muted.pop(); }
        else if (!rawText.has(tag)) suppressed.depth++;
      } else if (!rawText.has(suppressed.tag) && !closing && (ignored.has(tag) || rawText.has(tag)) && !voidElements.has(tag)) {
        // A parent's apparent closing tag inside nested active text is not a
        // real parent boundary. Keep the parent suppressed until that text ends.
        muted.push({ tag, depth: 1 });
      }
      continue;
    }
    if (!closing && (ignored.has(tag) || /\b(?:hidden|aria-hidden\s*=\s*["']?true)\b/i.test(raw))) {
      // A trailing slash does not close an HTML non-void element. Honour only
      // actual void elements; ambiguous foreign self-closing markup may reject
      // conservatively rather than expose active/hidden contents as evidence.
      if (!voidElements.has(tag)) muted.push({ tag, depth: 1 });
      continue;
    }
    if (tag === "title") { inTitle = !closing; continue; }
    if (blocks.has(tag)) output.push("\n");
  }
  if (muted.length || inTitle) throw new PublicWebError("WEB_UNSUPPORTED");
  const text = inertText(entities(output.join("")));
  if (!text) throw new PublicWebError("WEB_UNSUPPORTED");
  const safeTitle = Array.from(inertText(entities(title.join("")))).slice(0, 256).join("");
  return { text, ...(safeTitle ? { title: safeTitle } : {}) };
}
