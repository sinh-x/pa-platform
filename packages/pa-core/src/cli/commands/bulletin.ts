import { BulletinStore } from "../../bulletins/index.js";
import type { BulletinBlock } from "../../bulletins/index.js";
import { formatBulletinList } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { consumeJsonFlag, parseFlagPairs, printError, splitCsv } from "../utils.js";
import { sanitizeTextInput } from "../../deploy/control.js";

function parseBulletinCreateArgs(argv: string[]): { title: string; block: BulletinBlock; except?: string[]; body: string; warnings?: string[] } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--title", "--block", "--except", "--message"]));
  if ("error" in result) return result;
  const title = result.values["--title"];
  const block = result.values["--block"];
  if (!title) return { error: "--title is required" };
  if (!block) return { error: "--block is required" };
  const warnings: string[] = [];
  const titleResult = sanitizeTextInput(title);
  if (titleResult.removed > 0) warnings.push(`sanitized title: removed ${titleResult.removed} invalid character(s)`);
  const bodyRaw = result.values["--message"] ?? "";
  const bodyResult = sanitizeTextInput(bodyRaw);
  if (bodyResult.removed > 0) warnings.push(`sanitized message: removed ${bodyResult.removed} invalid character(s)`);
  const parsed: { title: string; block: BulletinBlock; except?: string[]; body: string; warnings?: string[] } = { title: titleResult.sanitized, block: block === "all" ? "all" : splitCsv(block), except: splitCsv(result.values["--except"]), body: bodyResult.sanitized };
  if (warnings.length > 0) parsed.warnings = warnings;
  return parsed;
}

export function runBulletinCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new BulletinStore();
  if (subcommand === "list") {
    const json = consumeJsonFlag(rest);
    if ("error" in json) return printError(json.error, io);
    const bulletins = store.readActive();
    io.stdout(json.json ? JSON.stringify(bulletins, null, 2) : formatBulletinList(bulletins));
    return 0;
  }
  if (subcommand === "create") {
    const parsed = parseBulletinCreateArgs(rest);
    if ("error" in parsed) return printError(parsed.error, io);
    if (parsed.warnings) for (const w of parsed.warnings) io.stderr(w);
    const bulletin = store.create(parsed);
    io.stdout(`Created ${bulletin.id}: ${bulletin.title}`);
    return 0;
  }
  if (subcommand === "resolve") {
    const id = rest[0];
    if (!id) return printError("bulletin resolve requires id", io);
    if (!store.resolve(id)) return printError(`Bulletin not found: ${id}`, io);
    io.stdout(`Resolved ${id}`);
    return 0;
  }
  io.stderr(`Unknown bulletin subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, create, resolve");
  return 1;
}
