import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getQueueDir, getSignalDir, getTicketsDir } from "../paths.js";
import { TicketStore } from "../tickets/store.js";
import type { RoutingResult } from "./types.js";

export interface SignalWriterPaths {
  learningRepo: string;
  journalsDir: string;
  pagesDir: string;
  signalBase: string;
  sensitiveDir: string;
  youtubeQueue: string;
  ticketsDir: string;
}

export interface SignalWriterOptions {
  paths?: Partial<SignalWriterPaths>;
}

export interface WriteResult {
  destination: string;
  path: string;
  ticketId?: string;
}

export function getSignalWriterPaths(overrides: Partial<SignalWriterPaths> = {}): SignalWriterPaths {
  const learningRepo = overrides.learningRepo ?? resolve(homedir(), "git-repos/sinh-x/tools/learning-management");
  const signalBase = overrides.signalBase ?? getSignalDir();
  return {
    learningRepo,
    journalsDir: overrides.journalsDir ?? resolve(learningRepo, "journals"),
    pagesDir: overrides.pagesDir ?? resolve(learningRepo, "pages"),
    signalBase,
    sensitiveDir: overrides.sensitiveDir ?? resolve(signalBase, "sensitive"),
    youtubeQueue: overrides.youtubeQueue ?? resolve(getQueueDir(), "youtube-video-queue.txt"),
    ticketsDir: overrides.ticketsDir ?? getTicketsDir(),
  };
}

export function cleanSignalEntries(options: SignalWriterOptions = {}): number {
  const paths = getSignalWriterPaths(options.paths);
  let cleaned = 0;
  if (existsSync(paths.journalsDir)) {
    for (const file of readdirSync(paths.journalsDir).filter((name) => name.endsWith(".md"))) {
      const filePath = resolve(paths.journalsDir, file);
      const lines = readFileSync(filePath, "utf-8").split("\n");
      const filtered: string[] = [];
      let skipIndented = false;
      for (const line of lines) {
        if (line.startsWith("- #signal ")) {
          skipIndented = true;
          cleaned++;
          continue;
        }
        if (skipIndented && line.startsWith("  - ")) continue;
        skipIndented = false;
        filtered.push(line);
      }
      if (filtered.length < lines.length) {
        const next = filtered.join("\n");
        if (!next.trim() || next.trim() === "-") unlinkSync(filePath);
        else writeFileSync(filePath, next, "utf-8");
      }
    }
  }
  if (existsSync(paths.sensitiveDir)) {
    for (const file of readdirSync(paths.sensitiveDir).filter((name) => name.endsWith(".log"))) unlinkSync(resolve(paths.sensitiveDir, file));
  }
  const signalPagesDir = resolve(paths.pagesDir, "signal");
  if (existsSync(signalPagesDir)) {
    for (const file of readdirSync(signalPagesDir).filter((name) => name.endsWith(".md"))) {
      unlinkSync(resolve(signalPagesDir, file));
      cleaned++;
    }
  }
  return cleaned;
}

export function writeRoutedMessage(result: RoutingResult, sentAt: number, options: SignalWriterOptions = {}): WriteResult {
  const date = new Date(sentAt);
  const paths = getSignalWriterPaths(options.paths);
  switch (result.destination) {
    case "ticket-idea":
      return writeTicket(result, "idea", "low", paths);
    case "ticket-task":
      return writeTicket(result, "task", "medium", paths);
    case "ticket-buy":
      return writeTicket(result, "task", "medium", paths, ["category:shopping"]);
    case "youtube-queue":
      return writeYoutubeQueue(result, date, paths);
    case "spike-queue":
      return writeMediaEntry(date, "article", result.detectedUrl ?? result.content.trim(), paths);
    case "bookmark":
      return writeJournalBlock(date, `- #signal #bookmark ${result.detectedUrl ?? result.content.trim()}`, "bookmark", paths);
    case "sensitive":
      return writeSensitive(result, date, paths);
    case "attachment-only":
      return writeJournalBlock(date, `- #signal #attachment ${result.attachmentPaths.length} file(s) - encrypted Signal attachment(s), review in Signal Desktop`, "attachment-only", paths);
    case "daily-log":
    default:
      return writeJournalBlock(date, `- #signal ${result.content || "(empty)"}`, "daily-log", paths);
  }
}

function writeTicket(result: RoutingResult, type: "idea" | "task", priority: "low" | "medium", paths: SignalWriterPaths, extraTags: string[] = []): WriteResult {
  const summaryParts = [result.content];
  if (result.attachmentPaths.length > 0) summaryParts.push("\n## Attachments", ...result.attachmentPaths.map((path) => `- ${path}`));
  const ticket = new TicketStore(paths.ticketsDir).create({
    project: "pa",
    title: result.content.slice(0, 60) || "Signal note",
    summary: summaryParts.join("\n"),
    description: "",
    status: "idea",
    priority,
    type,
    assignee: "sinh",
    estimate: "M",
    tags: ["source:signal", ...extraTags],
    blockedBy: [],
    doc_refs: [],
    comments: [],
    from: "",
    to: "",
  }, "pa-signal-collector");
  return { destination: `ticket (${type})`, path: ticket.id, ticketId: ticket.id };
}

function writeYoutubeQueue(result: RoutingResult, date: Date, paths: SignalWriterPaths): WriteResult {
  const url = result.detectedUrl ?? result.content.trim();
  if (existsSync(paths.youtubeQueue)) appendFileSync(paths.youtubeQueue, `${url}\n`, "utf-8");
  return writeMediaEntry(date, "youtube", url, paths);
}

function writeMediaEntry(date: Date, mediaType: "youtube" | "article", url: string, paths: SignalWriterPaths): WriteResult {
  const ds = dateStr(date);
  const slug = urlToSlug(url);
  const pageName = `signal/${ds}-${slug}`;
  const pageDir = resolve(paths.pagesDir, "signal");
  const pagePath = resolve(pageDir, `${ds}-${slug}.md`);
  const tagLabel = mediaType === "youtube" ? "#youtube" : "#article";
  const ticket = new TicketStore(paths.ticketsDir).create({
    project: "lm",
    title: `${mediaType === "youtube" ? "Watch" : "Read"}: ${url.slice(0, 50)}`,
    summary: `${mediaType === "youtube" ? "YouTube video" : "Article"} from Signal Note to Self.\n\nURL: ${url}\nLogseq page: [[${pageName}]]`,
    description: "",
    status: "pending-approval",
    priority: "low",
    type: "task",
    assignee: "sinh",
    estimate: "S",
    tags: ["source:signal", `category:${mediaType}`],
    blockedBy: [],
    doc_refs: [],
    comments: [],
    from: "",
    to: "",
  }, "pa-signal-collector");
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(pagePath, [`type:: ${mediaType}`, `url:: ${url}`, "source:: signal", "status:: pending", `ticket:: ${ticket.id}`, `date:: ${ds}`, "", `- ${tagLabel} ${url}`, `- ticket: ${ticket.id}`, ""].join("\n"), "utf-8");
  appendToJournal(date, `- #signal ${tagLabel} [[${pageName}]] (${ticket.id})`, paths);
  return { destination: `${mediaType}-page`, path: pagePath, ticketId: ticket.id };
}

function writeSensitive(result: RoutingResult, date: Date, paths: SignalWriterPaths): WriteResult {
  mkdirSync(paths.sensitiveDir, { recursive: true });
  const filePath = resolve(paths.sensitiveDir, `${dateStr(date)}.log`);
  appendFileSync(filePath, `[${timeStr(date)}] ${result.content}\n`, "utf-8");
  chmodSync(filePath, 0o600);
  return { destination: "sensitive", path: filePath };
}

function writeJournalBlock(date: Date, block: string, destination: string, paths: SignalWriterPaths): WriteResult {
  return { destination, path: appendToJournal(date, block, paths) };
}

function appendToJournal(date: Date, block: string, paths: SignalWriterPaths): string {
  mkdirSync(paths.journalsDir, { recursive: true });
  const filePath = resolve(paths.journalsDir, journalFilename(date));
  if (!existsSync(filePath)) writeFileSync(filePath, "-\n", "utf-8");
  appendFileSync(filePath, `${block}\n`, "utf-8");
  return filePath;
}

function journalFilename(date: Date): string {
  return `${date.getFullYear()}_${String(date.getMonth() + 1).padStart(2, "0")}_${String(date.getDate()).padStart(2, "0")}.md`;
}

function timeStr(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function urlToSlug(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
