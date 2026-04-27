import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getSignalDir } from "../paths.js";
import { nowUtc } from "../time.js";
import type { AttachmentMeta, NoteToSelfMessage, SignalAccountIdentity, SignalCollectorState, SignalConversation, SignalMessage } from "./types.js";

const DEFAULT_DB_PATH = resolve(homedir(), ".config/Signal/sql/db.sqlite");
const DEFAULT_CONFIG_PATH = resolve(homedir(), ".config/Signal/config.json");
const DEFAULT_ATTACHMENTS_DIR = resolve(homedir(), ".config/Signal/attachments.noindex");

export interface SignalPaths {
  baseDir: string;
  rawDir: string;
  attachmentsDir: string;
  processedDir: string;
  stateFilePath: string;
}

export interface SqlcipherOptions {
  dbPath?: string;
  key?: string;
  configPath?: string;
  sqlcipherPath?: string;
}

export interface ExtractNotesOptions extends SqlcipherOptions {
  signalBaseDir?: string;
  sourceAttachmentsDir?: string;
  now?: () => Date;
  warn?: (message: string) => void;
}

export function getSignalPaths(baseDir = getSignalDir()): SignalPaths {
  return {
    baseDir,
    rawDir: resolve(baseDir, "raw"),
    attachmentsDir: resolve(baseDir, "attachments"),
    processedDir: resolve(baseDir, "processed"),
    stateFilePath: resolve(baseDir, "state.json"),
  };
}

export function readSignalKey(configPath = DEFAULT_CONFIG_PATH): string {
  if (!existsSync(configPath)) throw new Error(`Signal config not found: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as { key?: string };
  if (!config.key || !/^[a-fA-F0-9]{64}$/.test(config.key)) throw new Error(`Invalid Signal key in config.json (expected 64 hex chars, got ${config.key?.length ?? 0})`);
  return config.key;
}

export function querySignalSqlcipher(sql: string, opts: SqlcipherOptions = {}): string {
  const key = opts.key ?? readSignalKey(opts.configPath);
  const input = [`PRAGMA key="x'${key}'";`, "PRAGMA busy_timeout=5000;", "PRAGMA journal_mode=WAL;", sql].join("\n");
  return execFileSync(opts.sqlcipherPath ?? "sqlcipher", [opts.dbPath ?? DEFAULT_DB_PATH], { input, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
}

export function parseSqlcipherRows(output: string): string[][] {
  return output.split("\n").map((line) => line.trim()).filter((line) => line && line !== "ok").map((line) => line.split("|"));
}

export function getOwnIdentity(opts: SqlcipherOptions = {}): SignalAccountIdentity {
  const output = querySignalSqlcipher("SELECT id, json FROM items WHERE id IN ('uuid_id', 'number_id') ORDER BY id;", opts);
  const rows = parseSqlcipherRows(output);
  let e164 = "";
  let uuid = "";
  for (const row of rows) {
    if (row.length < 2) continue;
    const id = row[0];
    const jsonStr = row.slice(1).join("|");
    try {
      const value = ((JSON.parse(jsonStr) as { value?: string }).value ?? "").replace(/\.\d+$/, "");
      if (id === "number_id") e164 = value;
      if (id === "uuid_id") uuid = value;
    } catch {
      // Ignore malformed Signal rows.
    }
  }
  if (!e164 || !uuid) throw new Error(`Could not read own identity from Signal DB (e164='${e164}', uuid='${uuid}')`);
  return { e164, uuid };
}

export function findNoteToSelfConversation(identity: SignalAccountIdentity, opts: SqlcipherOptions = {}): SignalConversation | null {
  const sql = `SELECT id, type, name, profileName, profileFullName, e164, serviceId, active_at FROM conversations WHERE type='private' AND (serviceId=${sqlString(identity.uuid)} OR e164=${sqlString(identity.e164)}) LIMIT 1;`;
  const rows = parseSqlcipherRows(querySignalSqlcipher(sql, opts));
  if (rows.length === 0) return null;
  const [id, type, name, profileName, profileFullName, e164, serviceId, activeAt] = rows[0] ?? [];
  return { id: id ?? "", type: type ?? "", name: name || null, profileName: profileName || null, profileFullName: profileFullName || null, e164: e164 || null, serviceId: serviceId || null, active_at: activeAt ? Number.parseInt(activeAt, 10) : null };
}

export function fetchNotesSince(conversationId: string, sinceMs: number, opts: SqlcipherOptions = {}): SignalMessage[] {
  const sql = `SELECT id, conversationId, sent_at, received_at, type, body, hasAttachments, hasFileAttachments, hasVisualMediaAttachments, sourceServiceId FROM messages WHERE conversationId=${sqlString(conversationId)} AND type='outgoing' AND sent_at > ${sinceMs} ORDER BY sent_at ASC;`;
  return parseSqlcipherRows(querySignalSqlcipher(sql, opts)).filter((row) => row.length >= 10).map((row) => ({
    id: row[0] ?? "",
    conversationId: row[1] ?? "",
    sent_at: Number.parseInt(row[2] ?? "0", 10),
    received_at: Number.parseInt(row[3] ?? "0", 10),
    type: row[4] ?? "",
    body: row[5] || null,
    hasAttachments: Number.parseInt(row[6] ?? "0", 10),
    hasFileAttachments: Number.parseInt(row[7] ?? "0", 10),
    hasVisualMediaAttachments: Number.parseInt(row[8] ?? "0", 10),
    sourceServiceId: row[9] || null,
  }));
}

export function fetchAttachments(messageId: string, opts: SqlcipherOptions = {}): AttachmentMeta[] {
  const sql = `SELECT messageId, contentType, path, fileName, size, width, height, duration, attachmentType FROM message_attachments WHERE messageId=${sqlString(messageId)};`;
  return parseSqlcipherRows(querySignalSqlcipher(sql, opts)).filter((row) => row.length >= 9).map((row) => ({
    messageId: row[0] ?? "",
    contentType: row[1] ?? "",
    path: row[2] || null,
    fileName: row[3] || null,
    size: Number.parseInt(row[4] ?? "0", 10),
    width: row[5] ? Number.parseInt(row[5], 10) : null,
    height: row[6] ? Number.parseInt(row[6], 10) : null,
    duration: row[7] ? Number.parseFloat(row[7]) : null,
    attachmentType: row[8] ?? "",
  }));
}

export function resolveAttachmentPath(relativePath: string, attachmentsDir = DEFAULT_ATTACHMENTS_DIR): string {
  return resolve(attachmentsDir, relativePath);
}

export function buildNoteToSelfMessage(msg: SignalMessage, opts: SqlcipherOptions = {}): NoteToSelfMessage {
  return { id: msg.id, conversationId: msg.conversationId, sentAt: msg.sent_at, body: msg.body, attachments: msg.hasAttachments > 0 ? fetchAttachments(msg.id, opts) : [] };
}

export function ensureSignalFolderStructure(baseDir = getSignalDir()): void {
  const paths = getSignalPaths(baseDir);
  mkdirSync(paths.rawDir, { recursive: true });
  mkdirSync(paths.attachmentsDir, { recursive: true });
}

export function copyAttachments(note: NoteToSelfMessage, opts: Pick<ExtractNotesOptions, "signalBaseDir" | "sourceAttachmentsDir" | "warn"> = {}): string[] {
  if (note.attachments.length === 0) return [];
  const paths = getSignalPaths(opts.signalBaseDir);
  ensureSignalFolderStructure(paths.baseDir);
  const destPaths: string[] = [];
  for (const attachment of note.attachments) {
    if (!attachment.path) continue;
    const srcPath = resolve(opts.sourceAttachmentsDir ?? DEFAULT_ATTACHMENTS_DIR, attachment.path);
    if (!existsSync(srcPath)) {
      opts.warn?.(`Warning: attachment source not found: ${srcPath}`);
      continue;
    }
    const destPath = resolve(paths.attachmentsDir, `${formatTimestampForFile(note.sentAt)}-${attachment.fileName ?? basename(attachment.path)}`);
    try {
      copyFileSync(srcPath, destPath);
      destPaths.push(destPath);
    } catch (error) {
      opts.warn?.(`Warning: failed to copy attachment ${srcPath}: ${(error as Error).message}`);
    }
  }
  return destPaths;
}

export function readCollectorState(stateFilePath = getSignalPaths().stateFilePath): SignalCollectorState {
  if (!existsSync(stateFilePath)) return { lastProcessedAt: 0, lastRunAt: null, totalProcessed: 0 };
  try {
    return JSON.parse(readFileSync(stateFilePath, "utf-8")) as SignalCollectorState;
  } catch {
    return { lastProcessedAt: 0, lastRunAt: null, totalProcessed: 0 };
  }
}

export function writeCollectorState(state: SignalCollectorState, stateFilePath = getSignalPaths().stateFilePath): void {
  mkdirSync(resolve(stateFilePath, ".."), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf-8");
}

export function saveRawNote(note: NoteToSelfMessage, copiedAttachmentPaths: string[] = [], rawDir = getSignalPaths().rawDir): string {
  mkdirSync(rawDir, { recursive: true });
  const filePath = resolve(rawDir, `${formatTimestampForFile(note.sentAt)}-${messageHash(note.id, note.sentAt)}.md`);
  const attachmentPaths = note.attachments.map((attachment) => attachment.path).filter((path): path is string => path !== null);
  const frontmatter = [
    "---",
    `id: ${note.id}`,
    `conversationId: ${note.conversationId}`,
    `sentAt: ${note.sentAt}`,
    `sentAtISO: ${nowUtc(new Date(note.sentAt))}`,
    `hasAttachments: ${note.attachments.length > 0}`,
    attachmentPaths.length > 0 ? "attachments:" : null,
    ...attachmentPaths.map((path) => `  - ${path}`),
    copiedAttachmentPaths.length > 0 ? `attachmentsCopied: ${JSON.stringify(copiedAttachmentPaths)}` : null,
    "---",
    "",
  ].filter((line): line is string => line !== null).join("\n");
  writeFileSync(filePath, `${frontmatter}${note.body ?? ""}\n`, "utf-8");
  return filePath;
}

export function markSignalNoteAsProcessed(rawFilePath: string, processedDir = getSignalPaths().processedDir): string {
  mkdirSync(processedDir, { recursive: true });
  const processedPath = resolve(processedDir, basename(rawFilePath));
  writeFileSync(processedPath, readFileSync(rawFilePath, "utf-8"), "utf-8");
  return processedPath;
}

export function extractNotesSinceLastRun(conversationId: string, opts: ExtractNotesOptions = {}): { count: number; files: string[]; lastTimestamp: number } {
  const paths = getSignalPaths(opts.signalBaseDir);
  const state = readCollectorState(paths.stateFilePath);
  const messages = fetchNotesSince(conversationId, state.lastProcessedAt, opts);
  ensureSignalFolderStructure(paths.baseDir);
  const now = opts.now ?? (() => new Date());
  if (messages.length === 0) {
    writeCollectorState({ ...state, lastRunAt: nowUtc(now()) }, paths.stateFilePath);
    return { count: 0, files: [], lastTimestamp: state.lastProcessedAt };
  }
  const files: string[] = [];
  let lastTimestamp = state.lastProcessedAt;
  for (const msg of messages) {
    const note = buildNoteToSelfMessage(msg, opts);
    const copiedPaths = copyAttachments(note, opts);
    files.push(saveRawNote(note, copiedPaths, paths.rawDir));
    lastTimestamp = Math.max(lastTimestamp, msg.sent_at);
  }
  writeCollectorState({ lastProcessedAt: lastTimestamp, lastRunAt: nowUtc(now()), totalProcessed: state.totalProcessed + messages.length }, paths.stateFilePath);
  return { count: messages.length, files, lastTimestamp };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatTimestampForFile(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

function messageHash(id: string, timestampMs: number): string {
  return createHash("sha256").update(`${id}:${timestampMs}`).digest("hex").slice(0, 8);
}
