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

function printTrashListHelp(io: Required<CliIo>): void {
  io.stdout("Usage: trash list [options]");
  io.stdout("");
  io.stdout("List trash entries.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --status <status>   Filter by status");
  io.stdout("  --type <type>       Filter by file type");
  io.stdout("  --search <query>    Search by keyword");
  io.stdout("  --json              Output as JSON");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  trash list");
  io.stdout("  trash list --type file --json");
}

function printTrashMoveHelp(io: Required<CliIo>): void {
  io.stdout("Usage: trash move <path> [options]");
  io.stdout("");
  io.stdout("Move a file or directory to the trash.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --reason <text>     Reason for trashing (required)");
  io.stdout("  --actor <name>      Actor name for history");
  io.stdout("  --type <type>       File type classification");
  io.stdout("  --yes               Confirm destructive action (required)");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  trash move ./temp.log --reason \"Cleanup\" --yes");
  io.stdout("  trash move ./old-dir --reason \"No longer needed\" --type directory --yes");
}

function printTrashShowHelp(io: Required<CliIo>): void {
  io.stdout("Usage: trash show <id> [options]");
  io.stdout("");
  io.stdout("Show details for a trashed entry.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --json              Output as JSON");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  trash show t-001");
  io.stdout("  trash show t-001 --json");
}

function printTrashRestoreHelp(io: Required<CliIo>): void {
  io.stdout("Usage: trash restore <id> [options]");
  io.stdout("");
  io.stdout("Restore a trashed entry to its original location.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --force             Overwrite existing files");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  trash restore t-001");
  io.stdout("  trash restore t-001 --force");
}

function printTrashPurgeHelp(io: Required<CliIo>): void {
  io.stdout("Usage: trash purge [options]");
  io.stdout("");
  io.stdout("Permanently purge trashed entries (soft-delete by default).");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --days <n>          Purge entries older than N days");
  io.stdout("  --dry-run           Show what would be purged without deleting");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  trash purge");
  io.stdout("  trash purge --days 30");
  io.stdout("  trash purge --days 90 --dry-run");
}

function printTrashHelp(io: Required<CliIo>): void {
  io.stdout("Usage: trash <subcommand> [options]");
  io.stdout("");
  io.stdout("Manage trashed files and directories.");
  io.stdout("");
  io.stdout("Subcommands:");
  io.stdout("  list                List trash entries");
  io.stdout("  move                Move file to trash");
  io.stdout("  show                Show trash entry details");
  io.stdout("  restore             Restore from trash");
  io.stdout("  purge               Permanently purge trash");
  io.stdout("");
  io.stdout("Run 'trash <subcommand> --help' for detailed usage.");
}

export function runTrashCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new TrashStore();
  if (argv.length === 0 || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printTrashHelp(io);
    return 0;
  }
  if (subcommand === "list") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTrashListHelp(io);
      return 0;
    }
    const opts = parseTrashListArgs(rest);
    if ("error" in opts) return printError(opts.error, io);
    const { json, ...filters } = opts;
    const entries = store.list(filters);
    io.stdout(json ? JSON.stringify(entries, null, 2) : formatTrashList(entries));
    return 0;
  }
  if (subcommand === "move") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTrashMoveHelp(io);
      return 0;
    }
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
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTrashShowHelp(io);
      return 0;
    }
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
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTrashRestoreHelp(io);
      return 0;
    }
    const id = rest[0];
    if (!id) return printError("trash restore requires id", io);
    const force = rest.includes("--force");
    const entry = store.restore(id, { force });
    io.stdout(`Restored ${entry.id}: ${entry.originalPath}`);
    return 0;
  }
  if (subcommand === "purge") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTrashPurgeHelp(io);
      return 0;
    }
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
