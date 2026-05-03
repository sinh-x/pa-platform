import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getSignalDir } from "../../paths.js";
import { extractNotesSinceLastRun, fetchNotesSince, findNoteToSelfConversation, getOwnIdentity, getSignalPaths, markSignalNoteAsProcessed, readCollectorState } from "../../signal/reader.js";
import { routeMessage } from "../../signal/router.js";
import { cleanSignalEntries, writeRoutedMessage } from "../../signal/writers.js";
import { formatLocal, nowUtc, parseTimestamp } from "../../time.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

function parseSignalCollectArgs(argv: string[]): { dryRun: boolean; skipRoute: boolean; reprocess: boolean; conversationId?: string } | { error: string } {
  const opts: { dryRun: boolean; skipRoute: boolean; reprocess: boolean; conversationId?: string } = { dryRun: false, skipRoute: false, reprocess: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-route") opts.skipRoute = true;
    else if (arg === "--reprocess") opts.reprocess = true;
    else if (arg === "--conversation-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--conversation-id requires a value" };
      opts.conversationId = value;
      i += 1;
    } else return { error: `Unsupported signal collect option: ${arg}` };
  }
  return opts;
}

function runSignalCollect(opts: { dryRun: boolean; skipRoute: boolean; conversationId?: string }, io: Required<CliIo>): number {
  const state = readCollectorState();
  io.stdout("=== Signal Note to Self Collector ===");
  io.stdout(`Last processed: ${state.lastProcessedAt > 0 ? formatLocal(nowUtc(new Date(state.lastProcessedAt))) : "never"}`);
  io.stdout(`Total processed: ${state.totalProcessed}`);
  let conversationId = opts.conversationId;
  if (!conversationId) {
    const identity = getOwnIdentity();
    const conversation = findNoteToSelfConversation(identity);
    if (!conversation) return printError("Could not find Note to Self conversation", io);
    conversationId = conversation.id;
    io.stdout(`Own identity: ${identity.e164} (${identity.uuid})`);
  }
  io.stdout(`Note to Self conversation: ${conversationId}${opts.conversationId ? " (override)" : ""}`);
  if (opts.dryRun) {
    const messages = fetchNotesSince(conversationId, state.lastProcessedAt);
    io.stdout(messages.length === 0 ? "No new messages found." : `Would extract ${messages.length} new message(s).`);
    for (const msg of messages) io.stdout(`  [${formatLocal(nowUtc(new Date(msg.sent_at)))}] ${(msg.body ?? "(no text body)").slice(0, 80).replace(/\n/g, " ")}`);
    return 0;
  }
  const result = extractNotesSinceLastRun(conversationId);
  io.stdout(result.count === 0 ? "No new messages found." : `Extracted ${result.count} new message(s).`);
  for (const file of result.files) io.stdout(`  ${file}`);
  if (!opts.skipRoute && result.files.length > 0) routeSignalFiles(result.files, false, io);
  return 0;
}

function runSignalReprocess(dryRun: boolean, io: Required<CliIo>): number {
  const rawDir = getSignalPaths(getSignalDir()).rawDir;
  if (!existsSync(rawDir)) {
    io.stdout("No raw notes found in signal/raw/.");
    return 0;
  }
  const files = readdirSync(rawDir).filter((file) => file.endsWith(".md")).map((file) => join(rawDir, file));
  if (files.length === 0) {
    io.stdout("No raw notes found in signal/raw/.");
    return 0;
  }
  io.stdout(`Found ${files.length} raw note(s) to reprocess.`);
  if (!dryRun) io.stdout(`Removed ${cleanSignalEntries()} previous entries.`);
  routeSignalFiles(files, dryRun, io);
  return 0;
}

function routeSignalFiles(files: string[], dryRun: boolean, io: Required<CliIo>): void {
  let routed = 0;
  let errors = 0;
  for (const file of files) {
    try {
      const result = routeMessage(file);
      const sentAt = extractSentAtFromFile(file);
      if (dryRun) io.stdout(`  [${localDateStr(nowUtc(new Date(sentAt)))}] ${result.destination} <- ${basename(file)}`);
      else {
        const writeResult = writeRoutedMessage(result, sentAt);
        markSignalNoteAsProcessed(file);
        io.stdout(`  ${result.destination.padEnd(16)} -> ${writeResult.path}${writeResult.ticketId ? ` (${writeResult.ticketId})` : ""}`);
      }
      routed += 1;
    } catch (error) {
      errors += 1;
      io.stderr(`ERROR: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  io.stdout(`Routed ${routed} note(s). Errors: ${errors}.`);
}

function extractSentAtFromFile(filePath: string): number {
  const match = readFileSync(filePath, "utf-8").match(/^sentAt:\s*(\d+)/m);
  return match ? Number.parseInt(match[1]!, 10) : Date.now();
}

function localDateStr(timestamp: string): string {
  return parseTimestamp(timestamp).toLocaleDateString("en-CA");
}

export function runSignalCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "collect") {
    io.stderr(`Unknown signal subcommand: ${subcommand ?? ""}`.trim());
    io.stderr("Available subcommands: collect");
    return 1;
  }
  const opts = parseSignalCollectArgs(rest);
  if ("error" in opts) return printError(opts.error, io);
  if (opts.reprocess) return runSignalReprocess(opts.dryRun, io);
  return runSignalCollect(opts, io);
}
