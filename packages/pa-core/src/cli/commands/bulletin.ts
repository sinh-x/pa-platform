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

function printBulletinListHelp(io: Required<CliIo>): void {
  io.stdout("Usage: bulletin list [options]");
  io.stdout("");
  io.stdout("List active bulletins.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --json              Output as JSON");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  bulletin list");
  io.stdout("  bulletin list --json");
}

function printBulletinCreateHelp(io: Required<CliIo>): void {
  io.stdout("Usage: bulletin create [options]");
  io.stdout("");
  io.stdout("Create a new bulletin to block or notify teams.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --title <text>      Bulletin title (required)");
  io.stdout("  --block <teams>     Teams to block (comma-separated, or \"all\") (required)");
  io.stdout("  --except <teams>    Teams to exclude from block (comma-separated)");
  io.stdout("  --message <text>    Bulletin body message");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  bulletin create --title \"Maintenance\" --block all --message \"System down\"");
  io.stdout("  bulletin create --title \"Docs update\" --block builder --message \"Review needed\"");
}

function printBulletinResolveHelp(io: Required<CliIo>): void {
  io.stdout("Usage: bulletin resolve <id>");
  io.stdout("");
  io.stdout("Resolve an active bulletin by its ID.");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  bulletin resolve b-001");
}

function printBulletinHelp(io: Required<CliIo>): void {
  io.stdout("Usage: bulletin <subcommand> [options]");
  io.stdout("");
  io.stdout("Manage bulletins for team notification and blocking.");
  io.stdout("");
  io.stdout("Subcommands:");
  io.stdout("  list                List active bulletins");
  io.stdout("  create              Create a new bulletin");
  io.stdout("  resolve             Resolve an active bulletin");
  io.stdout("");
  io.stdout("Run 'bulletin <subcommand> --help' for detailed usage.");
}

export function runBulletinCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new BulletinStore();
  if (argv.length === 0 || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printBulletinHelp(io);
    return 0;
  }
  if (subcommand === "list") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printBulletinListHelp(io);
      return 0;
    }
    const json = consumeJsonFlag(rest);
    if ("error" in json) return printError(json.error, io);
    const bulletins = store.readActive();
    io.stdout(json.json ? JSON.stringify(bulletins, null, 2) : formatBulletinList(bulletins));
    return 0;
  }
  if (subcommand === "create") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printBulletinCreateHelp(io);
      return 0;
    }
    const parsed = parseBulletinCreateArgs(rest);
    if ("error" in parsed) return printError(parsed.error, io);
    if (parsed.warnings) for (const w of parsed.warnings) io.stderr(w);
    const bulletin = store.create(parsed);
    io.stdout(`Created ${bulletin.id}: ${bulletin.title}`);
    return 0;
  }
  if (subcommand === "resolve") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printBulletinResolveHelp(io);
      return 0;
    }
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
