import { TrashStore } from "../../trash/index.js";
import type { TrashFileType, TrashStatus } from "../../trash/index.js";
import { formatTrashList, formatTrashShow } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { consumeJsonFlag, parseFlagPairs, printError } from "../utils.js";

function parseTrashListArgs(argv: string[]): { status?: TrashStatus; fileType?: TrashFileType; search?: string; json?: boolean } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--status", "--type", "--search", "--json"]), new Set(["--json"]));
  if ("error" in result) return result;
  return { status: result.values["--status"] as TrashStatus | undefined, fileType: result.values["--type"] as TrashFileType | undefined, search: result.values["--search"], json: result.booleans.has("--json") };
}

function parseTrashMoveArgs(argv: string[]): { reason: string; actor: string; fileType?: TrashFileType; yes: boolean } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--reason", "--actor", "--type", "--yes"]), new Set(["--yes"]));
  if ("error" in result) return result;
  if (!result.values["--reason"]) return { error: "--reason is required" };
  return { reason: result.values["--reason"]!, actor: result.values["--actor"] ?? "pa-core", fileType: result.values["--type"] as TrashFileType | undefined, yes: result.booleans.has("--yes") };
}

function parseTrashPurgeArgs(argv: string[]): { days?: number; dryRun?: boolean } | { error: string } {
  const opts: { days?: number; dryRun?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--days") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--days requires a value" };
      const days = Number(value);
      if (!Number.isInteger(days) || days < 0) return { error: "--days must be a non-negative integer" };
      opts.days = days;
      i += 1;
    } else return { error: `Unsupported trash purge option: ${arg}` };
  }
  return opts;
}

export function runTrashCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new TrashStore();
  if (subcommand === "list") {
    const opts = parseTrashListArgs(rest);
    if ("error" in opts) return printError(opts.error, io);
    const { json, ...filters } = opts;
    const entries = store.list(filters);
    io.stdout(json ? JSON.stringify(entries, null, 2) : formatTrashList(entries));
    return 0;
  }
  if (subcommand === "move") {
    const path = rest[0];
    if (!path) return printError("trash move requires path", io);
    const parsed = parseTrashMoveArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
    if (!parsed.yes) return printError("trash move is destructive; rerun with --yes to confirm", io);
    io.stderr(`Moving to trash: ${path}`);
    const entry = store.move({ path, reason: parsed.reason, actor: parsed.actor, fileType: parsed.fileType });
    io.stdout(`Trashed ${entry.id}: ${entry.originalPath}`);
    return 0;
  }
  if (subcommand === "show") {
    const id = rest[0];
    if (!id) return printError("trash show requires id", io);
    const entry = store.get(id);
    if (!entry) return printError(`Trash entry not found: ${id}`, io);
    const json = consumeJsonFlag(rest.slice(1));
    if ("error" in json) return printError(json.error, io);
    io.stdout(json.json ? JSON.stringify(entry, null, 2) : formatTrashShow(entry));
    return 0;
  }
  if (subcommand === "restore") {
    const id = rest[0];
    if (!id) return printError("trash restore requires id", io);
    const force = rest.includes("--force");
    const entry = store.restore(id, { force });
    io.stdout(`Restored ${entry.id}: ${entry.originalPath}`);
    return 0;
  }
  if (subcommand === "purge") {
    const opts = parseTrashPurgeArgs(rest);
    if ("error" in opts) return printError(opts.error, io);
    const purged = store.purge(opts);
    io.stdout(`${opts.dryRun ? "Would purge" : "Purged"}: ${purged.length}`);
    return 0;
  }
  io.stderr(`Unknown trash subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, move, show, restore, purge");
  return 1;
}
