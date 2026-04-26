import { readFileSync } from "node:fs";
import { parseJsonArrayFrontmatter, parseSignalNoteMarkdown } from "./markdown.js";
import { isSensitive } from "./sensitive.js";
import type { PrefixTag, RouteDestination, RoutingResult } from "./types.js";

const VALID_TAGS = new Set(["idea", "task", "learn", "yt", "buy", "link", "secret"]);
const YOUTUBE_RE = /(?:youtube\.com\/|youtu\.be\/)/i;
const FACEBOOK_RE = /facebook\.com\/share\//i;
const URL_RE = /https?:\/\/[^\s]+/i;
const ARTICLE_DOMAINS = ["howtogeek.com", "reddit.com", "github.com", "docs.google.com", "medium.com", "dev.to", "stackoverflow.com", "news.ycombinator.com"];

export type UrlType = "youtube" | "facebook" | "article" | "generic" | null;

const TAG_DESTINATION: Record<PrefixTag, RouteDestination> = {
  idea: "ticket-idea",
  task: "ticket-task",
  learn: "spike-queue",
  yt: "youtube-queue",
  buy: "ticket-buy",
  link: "bookmark",
  secret: "sensitive",
};

export function parseTag(body: string): { tag: PrefixTag; content: string } | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("#")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  const tagWord = spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1);
  const normalized = tagWord.toLowerCase();
  if (!VALID_TAGS.has(normalized)) return null;
  return { tag: normalized as PrefixTag, content: spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : "" };
}

export function detectUrlType(body: string): { type: UrlType; url: string | null } {
  const match = body.match(URL_RE);
  if (!match) return { type: null, url: null };
  const url = match[0];
  if (YOUTUBE_RE.test(url)) return { type: "youtube", url };
  if (FACEBOOK_RE.test(url)) return { type: "facebook", url };
  if (ARTICLE_DOMAINS.some((domain) => url.includes(domain))) return { type: "article", url };
  return { type: "generic", url };
}

export function routeRawSignalNote(content: string): RoutingResult {
  const { frontmatter, body } = parseSignalNoteMarkdown(content);
  const attachmentPaths = parseJsonArrayFrontmatter(frontmatter["attachmentsCopied"]);
  if (!body) return result("attachment-only", "", null, null, false, true, attachmentPaths);

  const tagResult = parseTag(body);
  if (tagResult) return result(TAG_DESTINATION[tagResult.tag], tagResult.content, tagResult.tag, null, tagResult.tag === "secret", false, attachmentPaths);
  if (isSensitive(body)) return result("sensitive", body, null, null, true, false, attachmentPaths);

  const urlResult = detectUrlType(body);
  if (urlResult.type === "youtube") return result("youtube-queue", body, null, urlResult.url, false, false, attachmentPaths);
  if (urlResult.type === "facebook") return result("bookmark", body, null, urlResult.url, false, false, attachmentPaths);
  if (urlResult.type === "article") return result("spike-queue", body, null, urlResult.url, false, false, attachmentPaths);
  if (urlResult.type === "generic") return result("bookmark", body, null, urlResult.url, false, false, attachmentPaths);
  return result("daily-log", body, null, null, false, false, attachmentPaths);
}

export function routeMessage(rawFilePath: string): RoutingResult {
  return routeRawSignalNote(readFileSync(rawFilePath, "utf-8"));
}

function result(destination: RouteDestination, content: string, tag: PrefixTag | null, detectedUrl: string | null, sensitiveDetected: boolean, attachmentOnly: boolean, attachmentPaths: string[]): RoutingResult {
  return { destination, content, tag, detectedUrl, sensitiveDetected, attachmentOnly, attachmentPaths };
}
