import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listRepos, resolveProjectFromCwd } from "../../repos.js";
import { readGuardedLocalTextFile } from "../../sensitive-patterns.js";
import { TicketStore } from "../../tickets/index.js";
import { nowUtc } from "../../time.js";
import type { CreateTicketInput, Estimate, SubTicketStatus, TicketPriority, TicketStatus, TicketType } from "../../tickets/index.js";
import type { CliIo } from "../utils.js";
import { formatTicketList, formatTicketShow } from "../formatters.js";
import { sanitizeTextInput } from "../../deploy/control.js";

function printTicketMoveHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket move <id> [options]");
  io.stdout("");
  io.stdout("Move a ticket to a different project.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --project <name>    Target project (required)");
  io.stdout("  --actor <name>      Actor name for history");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket move PAP-120 --project pa-platform");
  io.stdout("  ticket move PAP-120 --project other-project --actor sinh");
}

function printTicketDeleteHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket delete <id> [options]");
  io.stdout("");
  io.stdout("Delete a ticket (soft-delete by default, changing status to cancelled).");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --force             Hard-delete the ticket");
  io.stdout("  --yes               Confirm destructive action");
  io.stdout("  --actor <name>      Actor name for history");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket delete PAP-120");
  io.stdout("  ticket delete PAP-120 --force --yes");
}

function printTicketCheckRefsHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket check-refs [options]");
  io.stdout("");
  io.stdout("Check doc_refs for all tickets in a project and report orphaned paths.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --project <name>    Project to check (required)");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket check-refs --project pa-platform");
}

function printTicketSubticketHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket subticket <subcommand> <parent-id> [sub-id] [options]");
  io.stdout("");
  io.stdout("Manage sub-tickets within a parent ticket.");
  io.stdout("");
  io.stdout("Subcommands:");
  io.stdout("  create              Create a new sub-ticket");
  io.stdout("  list                List sub-tickets");
  io.stdout("  update              Update a sub-ticket");
  io.stdout("  complete            Mark a sub-ticket as done");
  io.stdout("");
  io.stdout("Run 'ticket subticket <subcommand> --help' for detailed usage.");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket subticket list PAP-120");
  io.stdout("  ticket subticket create PAP-120 --title \"Sub task\"");
  io.stdout("  ticket subticket complete PAP-120 ST-001");
}

function printTicketUpdateHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket update <id> [options]");
  io.stdout("");
  io.stdout("Update a ticket's properties. Only the options you pass are applied.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --status <status>           New status");
  io.stdout("  --assignee <name>           New assignee");
  io.stdout("  --priority <p>              Priority (low, medium, high, critical)");
  io.stdout("  --tags <csv>                 Comma-separated tags (replaces existing)");
  io.stdout("  --blocked-by <csv>           Comma-separated blocked-by ticket ids");
  io.stdout("  --estimate <size>           Estimate (XS, S, M, L, XL)");
  io.stdout("  --title <text>               New title");
  io.stdout("  --summary <text>            New summary");
  io.stdout("  --description <text>        New description");
  io.stdout("  --doc-ref <type:path>       Add a doc_ref (optionally --doc-ref-primary)");
  io.stdout("  --remove-doc-ref <path>      Remove a doc_ref by path");
  io.stdout("  --linked-branch <repo|branch|sha> Add a linked branch");
  io.stdout("  --remove-linked-branch <repo> Remove a linked branch by repo");
  io.stdout("  --linked-commit <repo|sha|msg|author|ts> Add a linked commit");
  io.stdout("  --remove-linked-commit <sha> Remove a linked commit by sha");
  io.stdout("  --actor <name>              Actor name for history");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket update PAP-120 --status implementing --assignee builder/team-manager");
  io.stdout("  ticket update PAP-120 --title \"New title\" --summary \"New summary\"");
  io.stdout("  ticket update PAP-120 --doc-ref \"requirements:agent-teams/builder/req.md\"");
}

function printTicketArchiveHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket archive <id> [options]");
  io.stdout("");
  io.stdout("Archive a terminal-status ticket by adding the \"archived\" tag.");
  io.stdout("Only tickets in a terminal status (done, rejected, cancelled) can be archived.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --actor <name>      Actor name for history");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket archive PAP-120");
  io.stdout("  ticket archive PAP-120 --actor sinh");
}

function printTicketUnarchiveHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket unarchive <id> [options]");
  io.stdout("");
  io.stdout("Unarchive a ticket by removing the \"archived\" tag.");
  io.stdout("No-op if the ticket is not currently archived.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --actor <name>      Actor name for history");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket unarchive PAP-120");
  io.stdout("  ticket unarchive PAP-120 --actor sinh");
}

function printTicketHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket <subcommand> [options]");
  io.stdout("");
  io.stdout("Manage tickets.");
  io.stdout("");
  io.stdout("Subcommands:");
  io.stdout("  list                List tickets");
  io.stdout("  show                Show ticket details");
  io.stdout("  create              Create a new ticket");
  io.stdout("  update              Update a ticket");
  io.stdout("  comment             Add a comment to a ticket");
  io.stdout("  attach              Attach a file to a ticket");
  io.stdout("  move                Move ticket to another project");
  io.stdout("  delete              Delete a ticket");
  io.stdout("  archive             Archive a terminal-status ticket");
  io.stdout("  unarchive           Unarchive a ticket");
  io.stdout("  check-refs          Check doc_ref validity");
  io.stdout("  subticket           Manage sub-tickets");
  io.stdout("");
  io.stdout("Run 'ticket <subcommand> --help' for detailed usage.");
}

export function runTicketCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new TicketStore();
  if (argv.length === 0 || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printTicketHelp(io);
    return 0;
  }
  if (subcommand === "list") {
    const opts = parseTicketListArgs(rest);
    if ("error" in opts) return printError(opts.error, io);
    const { json, ...filters } = opts;
    const tickets = store.list(filters);
    io.stdout(json ? JSON.stringify(tickets, null, 2) : formatTicketList(tickets));
    return 0;
  }
  if (subcommand === "show") {
    const id = rest[0];
    if (!id) return printError("ticket show requires id", io);
    const ticket = store.get(id);
    if (!ticket) return printError(`Ticket not found: ${id}`, io);
    const json = consumeJsonFlag(rest.slice(1));
    if ("error" in json) return printError(json.error, io);
    io.stdout(json.json ? JSON.stringify(ticket, null, 2) : formatTicketShow(ticket));
    return 0;
  }
  if (subcommand === "create") {
    const parsed = parseTicketCreateArgs(rest);
    if ("error" in parsed) return printError(parsed.error, io);
    if (parsed.warnings) for (const w of parsed.warnings) io.stderr(w);
    const ticket = store.create(parsed.input, parsed.actor);
    io.stdout(`Created ${ticket.id}: ${ticket.title}`);
    return 0;
  }
  if (subcommand === "update") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTicketUpdateHelp(io);
      return 0;
    }
    const id = rest[0];
    if (!id) return printError("ticket update requires id", io);
    const parsed = parseTicketUpdateArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
    if (parsed.warnings) for (const w of parsed.warnings) io.stderr(w);
    const ticket = store.update(id, parsed.input, parsed.actor);
    io.stdout(`Updated ${ticket.id}: ${ticket.status}`);
    return 0;
  }
  if (subcommand === "comment") {
    const id = rest[0];
    if (!id) return printError("ticket comment requires id", io);
    const parsed = parseTicketCommentArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
    if (parsed.warnings) for (const w of parsed.warnings) io.stderr(w);
    const comment = store.comment(id, parsed.author, parsed.content);
    io.stdout(`Commented ${id}: ${comment.id}`);
    return 0;
  }
  if (subcommand === "attach") {
    const id = rest[0];
    if (!id) return printError("ticket attach requires id", io);
    const parsed = parseFlagPairs(rest.slice(1), new Set(["--file", "--actor"]));
    if ("error" in parsed) return printError(parsed.error, io);
    const file = parsed.values["--file"];
    if (!file) return printError("--file is required", io);
    const ticket = store.attach(id, file, parsed.values["--actor"] ?? "pa-core");
    io.stdout(`Attached to ${ticket.id}: ${file}`);
    return 0;
  }
  if (subcommand === "move") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTicketMoveHelp(io);
      return 0;
    }
    const id = rest[0];
    if (!id) return printError("ticket move requires id", io);
    const parsed = parseFlagPairs(rest.slice(1), new Set(["--project", "--actor"]));
    if ("error" in parsed) return printError(parsed.error, io);
    const project = parsed.values["--project"];
    if (!project) return printError("--project is required", io);
    const ticket = store.move(id, project, parsed.values["--actor"] ?? "pa-core");
    io.stdout(`Moved: ${id} -> ${ticket.id}`);
    return 0;
  }
  if (subcommand === "delete") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTicketDeleteHelp(io);
      return 0;
    }
    const id = rest[0];
    if (!id) return printError("ticket delete requires id", io);
    const opts = parseTicketDeleteArgs(rest.slice(1));
    if ("error" in opts) return printError(opts.error, io);
    if (opts.force && !opts.yes) return printError("--force requires --yes in pa-core non-interactive mode", io);
    store.delete(id, opts.actor, opts.force);
    io.stdout(opts.force ? `Deleted (hard): ${id}` : `Deleted (soft): ${id} (status -> cancelled)`);
    return 0;
  }
  if (subcommand === "archive") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTicketArchiveHelp(io);
      return 0;
    }
    const id = rest[0];
    if (!id) return printError("ticket archive requires id", io);
    const parsed = parseFlagPairs(rest.slice(1), new Set(["--actor"]));
    if ("error" in parsed) return printError(parsed.error, io);
    try {
      const ticket = store.archive(id, parsed.values["--actor"] ?? "pa-core");
      io.stdout(`Archived ${ticket.id}: ${ticket.status}`);
      return 0;
    } catch (err) {
      return printError(err instanceof Error ? err.message : String(err), io);
    }
  }
  if (subcommand === "unarchive") {
    if (rest[0] === "--help" || rest[0] === "-h") {
      printTicketUnarchiveHelp(io);
      return 0;
    }
    const id = rest[0];
    if (!id) return printError("ticket unarchive requires id", io);
    const parsed = parseFlagPairs(rest.slice(1), new Set(["--actor"]));
    if ("error" in parsed) return printError(parsed.error, io);
    try {
      const ticket = store.unarchive(id, parsed.values["--actor"] ?? "pa-core");
      io.stdout(`Unarchived ${ticket.id}: ${ticket.status}`);
      return 0;
    } catch (err) {
      return printError(err instanceof Error ? err.message : String(err), io);
    }
  }
  if (subcommand === "check-refs") return runTicketCheckRefs(rest, io, store);
  if (subcommand === "subticket") return runSubTicketCommand(rest, io, store);
  io.stderr(`Unknown ticket subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, show, create, update, attach, comment, move, delete, archive, unarchive, check-refs, subticket");
  return 1;
}

function parseTicketListArgs(argv: string[]): { project?: string; status?: TicketStatus; assignee?: string; priority?: TicketPriority; type?: TicketType; search?: string; tags?: string[]; excludeTags?: string[]; json?: boolean } | { error: string } {
  const opts: { project?: string; status?: TicketStatus; assignee?: string; priority?: TicketPriority; type?: TicketType; search?: string; tags?: string[]; excludeTags?: string[]; json?: boolean } = {};
  const result = parseFlagPairs(argv, new Set(["--project", "--status", "--assignee", "--priority", "--type", "--search", "--tags", "--exclude-tags", "--json"]), new Set(["--json"]));
  if ("error" in result) return result;
  if (result.values["--project"]) opts.project = result.values["--project"];
  if (result.values["--status"]) opts.status = result.values["--status"] as TicketStatus;
  if (result.values["--assignee"]) opts.assignee = result.values["--assignee"];
  if (result.values["--priority"]) opts.priority = result.values["--priority"] as TicketPriority;
  if (result.values["--type"]) opts.type = result.values["--type"] as TicketType;
  if (result.values["--search"]) opts.search = result.values["--search"];
  if (result.values["--tags"]) opts.tags = splitCsv(result.values["--tags"]);
  if (result.values["--exclude-tags"]) opts.excludeTags = splitCsv(result.values["--exclude-tags"]);
  if (result.booleans.has("--json")) opts.json = true;
  return opts;
}

function parseTicketCreateArgs(argv: string[]): { input: CreateTicketInput; actor: string; warnings?: string[] } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--project", "--title", "--type", "--priority", "--estimate", "--assignee", "--summary", "--description", "--status", "--from", "--to", "--tags", "--doc-ref", "--actor"]));
  if ("error" in result) return result;
  const values = result.values;
  for (const flag of ["--title", "--type", "--priority", "--estimate", "--assignee"] as const) if (!values[flag]) return { error: `${flag} is required` };
  const project = values["--project"] ?? resolveProjectFromCwd()?.key;
  if (!project) {
    return { error: `Not in a registered repo. Use --project name, or run this inside a registered repo where --project is optional.${availableProjectGuidance()}` };
  }
  const actor = values["--actor"] ?? "pa-core";
  const docRef = values["--doc-ref"] ? parseDocRefFlag(values["--doc-ref"]!) : undefined;
  const warnings: string[] = [];
  const titleResult = sanitizeTextInput(values["--title"]!);
  if (titleResult.removed > 0) warnings.push(`sanitized title: removed ${titleResult.removed} invalid character(s)`);
  const summaryResult = sanitizeTextInput(values["--summary"] ?? "");
  if (summaryResult.removed > 0) warnings.push(`sanitized summary: removed ${summaryResult.removed} invalid character(s)`);
  const descriptionResult = sanitizeTextInput(values["--description"] ?? "");
  if (descriptionResult.removed > 0) warnings.push(`sanitized description: removed ${descriptionResult.removed} invalid character(s)`);
  const parsed: { input: CreateTicketInput; actor: string; warnings?: string[] } = { actor, input: { project, title: titleResult.sanitized, summary: summaryResult.sanitized, description: descriptionResult.sanitized, status: (values["--status"] ?? "idea") as TicketStatus, priority: values["--priority"] as TicketPriority, type: values["--type"] as TicketType, assignee: values["--assignee"]!, estimate: values["--estimate"] as Estimate, from: values["--from"] ?? "", to: values["--to"] ?? "", tags: splitCsv(values["--tags"]), blockedBy: [], doc_refs: docRef ? [{ type: docRef.type ?? "attachment", path: docRef.path, primary: true, addedAt: nowUtc(), addedBy: actor }] : [], comments: [] } };
  if (warnings.length > 0) parsed.warnings = warnings;
  return parsed;
}

function availableProjectGuidance(): string {
  const available = listRepos().filter((repo) => repo.prefix).map((repo) => repo.name).join(", ");
  return available ? ` Available projects: ${available}` : "";
}

function parseTicketUpdateArgs(argv: string[]): { input: { status?: TicketStatus; assignee?: string; priority?: TicketPriority; tags?: string[]; blockedBy?: string[]; estimate?: Estimate; title?: string; summary?: string; description?: string; add_doc_ref?: { path: string; type?: string; primary?: boolean }; remove_doc_ref?: string; add_linked_branch?: { repo: string; branch: string; sha?: string }; remove_linked_branch?: string; add_linked_commit?: { repo: string; sha: string; message?: string; author?: string; timestamp?: string }; remove_linked_commit?: string }; actor: string; warnings?: string[] } | { error: string } {
  const result = parseTicketUpdateFlagPairs(argv);
  if ("error" in result) return result;
  const values = result.values;
  const input: { status?: TicketStatus; assignee?: string; priority?: TicketPriority; tags?: string[]; blockedBy?: string[]; estimate?: Estimate; title?: string; summary?: string; description?: string; add_doc_ref?: { path: string; type?: string; primary?: boolean }; remove_doc_ref?: string; add_linked_branch?: { repo: string; branch: string; sha?: string }; remove_linked_branch?: string; add_linked_commit?: { repo: string; sha: string; message?: string; author?: string; timestamp?: string }; remove_linked_commit?: string } = {};
  if (values["--status"]) input.status = values["--status"] as TicketStatus;
  if (values["--assignee"]) input.assignee = values["--assignee"];
  if (values["--priority"]) input.priority = values["--priority"] as TicketPriority;
  if (values["--tags"]) input.tags = splitCsv(values["--tags"]);
  if (values["--blocked-by"] !== undefined) input.blockedBy = splitCsv(values["--blocked-by"]);
  if (values["--estimate"]) input.estimate = values["--estimate"] as Estimate;
  if (values["--doc-ref"]) input.add_doc_ref = { ...parseDocRefFlag(values["--doc-ref"]!), primary: result.booleans.has("--doc-ref-primary") };
  if (values["--remove-doc-ref"]) input.remove_doc_ref = values["--remove-doc-ref"];
  if (values["--linked-branch"]) input.add_linked_branch = parseLinkedBranchFlag(values["--linked-branch"]!);
  if (values["--remove-linked-branch"]) input.remove_linked_branch = values["--remove-linked-branch"];
  if (values["--linked-commit"]) input.add_linked_commit = parseLinkedCommitFlag(values["--linked-commit"]!);
  if (values["--remove-linked-commit"]) input.remove_linked_commit = values["--remove-linked-commit"];
  const warnings: string[] = [];
  if (values["--title"] !== undefined) {
    const rawTitle = values["--title"] ?? "";
    const titleResult = sanitizeTextInput(rawTitle);
    if (rawTitle.length > 0 && titleResult.sanitized.length === 0) {
      warnings.push(`title update skipped: sanitization removed all ${titleResult.removed} character(s); keeping existing title`);
    } else {
      input.title = titleResult.sanitized;
      if (titleResult.removed > 0) warnings.push(`sanitized ticket title: removed ${titleResult.removed} invalid character(s)`);
    }
  }
  if (values["--summary"] !== undefined) {
    const rawSummary = values["--summary"] ?? "";
    const summaryResult = sanitizeTextInput(rawSummary);
    if (rawSummary.length > 0 && summaryResult.sanitized.length === 0) {
      warnings.push(`summary update skipped: sanitization removed all ${summaryResult.removed} character(s); keeping existing summary`);
    } else {
      input.summary = summaryResult.sanitized;
      if (summaryResult.removed > 0) warnings.push(`sanitized ticket summary: removed ${summaryResult.removed} invalid character(s)`);
    }
  }
  if (values["--description"] !== undefined) {
    const rawDescription = values["--description"] ?? "";
    const descriptionResult = sanitizeTextInput(rawDescription);
    if (rawDescription.length > 0 && descriptionResult.sanitized.length === 0) {
      warnings.push(`description update skipped: sanitization removed all ${descriptionResult.removed} character(s); keeping existing description`);
    } else {
      input.description = descriptionResult.sanitized;
      if (descriptionResult.removed > 0) warnings.push(`sanitized ticket description: removed ${descriptionResult.removed} invalid character(s)`);
    }
  }
  const parsed: { input: typeof input; actor: string; warnings?: string[] } = { input, actor: values["--actor"] ?? "pa-core" };
  if (warnings.length > 0) parsed.warnings = warnings;
  return parsed;
}

function parseTicketCommentArgs(argv: string[]): { author: string; content: string; warnings?: string[] } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--author", "--content", "--content-file"]));
  if ("error" in result) return result;
  if (!result.values["--author"]) return { error: "--author is required" };
  if (result.values["--content"] && result.values["--content-file"]) return { error: "Use only one of --content or --content-file" };
  if (!result.values["--content"] && !result.values["--content-file"]) return { error: "one of --content or --content-file is required" };
  const rawContent = result.values["--content-file"] ? readGuardedLocalTextFile(result.values["--content-file"]!) : result.values["--content"]!;
  const sanitized = sanitizeTextInput(rawContent);
  const parsed: { author: string; content: string; warnings?: string[] } = { author: result.values["--author"]!, content: sanitized.sanitized };
  if (sanitized.removed > 0) parsed.warnings = [`sanitized comment content: removed ${sanitized.removed} invalid character(s)`];
  return parsed;
}

function parseTicketUpdateFlagPairs(argv: string[]): { values: Record<string, string>; booleans: Set<string> } | { error: string } {
  const valueFlags = new Set(["--status", "--assignee", "--priority", "--tags", "--blocked-by", "--estimate", "--doc-ref", "--remove-doc-ref", "--linked-branch", "--linked-commit", "--remove-linked-branch", "--remove-linked-commit", "--actor", "--title", "--summary", "--description"]);
  const booleanFlags = new Set(["--doc-ref-primary", "--force"]);
  return parseFlagPairs(argv, new Set([...valueFlags, ...booleanFlags]), booleanFlags);
}

function parseTicketDeleteArgs(argv: string[]): { force: boolean; yes: boolean; actor: string } | { error: string } {
  const opts = { force: false, yes: false, actor: "pa-core" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--force") opts.force = true;
    else if (arg === "--yes") opts.yes = true;
    else if (arg === "--actor") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--actor requires a value" };
      opts.actor = value;
      i += 1;
    } else return { error: `Unsupported ticket delete option: ${arg}` };
  }
  return opts;
}

function runTicketCheckRefs(argv: string[], io: Required<CliIo>, store: TicketStore): number {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printTicketCheckRefsHelp(io);
    return 0;
  }
  const parsed = parseFlagPairs(argv, new Set(["--project"]));
  if ("error" in parsed) return printError(parsed.error, io);
  const project = parsed.values["--project"];
  if (!project) return printError("--project is required", io);
  const orphans: Array<{ ticketId: string; type: string; path: string; addedAt: string }> = [];
  for (const ticket of store.list({ project })) {
    for (const ref of ticket.doc_refs) {
      if (ref.type === "url" || ref.path.startsWith("http://") || ref.path.startsWith("https://")) continue;
      if (!existsSync(resolve(ref.path))) orphans.push({ ticketId: ticket.id, type: ref.type, path: ref.path, addedAt: ref.addedAt });
    }
  }
  if (orphans.length === 0) {
    io.stdout(`All doc_refs in project '${project}' are valid.`);
    return 0;
  }
  io.stdout(`Orphaned doc_refs (${orphans.length}):`);
  for (const orphan of orphans) io.stdout(`${orphan.ticketId.padEnd(10)} ${orphan.type.padEnd(12)} ${orphan.path}`);
  return 1;
}

function printSubticketCreateHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket subticket create <parent-id> [options]");
  io.stdout("");
  io.stdout("Create a new sub-ticket under a parent ticket.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --title <text>      Sub-ticket title (required)");
  io.stdout("  --summary <text>    Sub-ticket summary");
  io.stdout("  --assignee <name>   Assignee");
  io.stdout("  --priority <p>      Priority (low, medium, high, critical)");
  io.stdout("  --estimate <size>   Estimate (XS, S, M, L, XL)");
  io.stdout("  --actor <name>      Actor name for history");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket subticket create PAP-120 --title \"Sub task\"");
  io.stdout("  ticket subticket create PAP-120 --title \"Bug fix\" --priority high");
}

function printSubticketListHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket subticket list <parent-id>");
  io.stdout("");
  io.stdout("List all sub-tickets for a parent ticket.");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket subticket list PAP-120");
}

function printSubticketUpdateHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket subticket update <parent-id> <sub-id> [options]");
  io.stdout("");
  io.stdout("Update a sub-ticket's properties.");
  io.stdout("");
  io.stdout("Options:");
  io.stdout("  --status <status>   Sub-ticket status");
  io.stdout("  --assignee <name>   Assignee");
  io.stdout("  --title <text>      New title");
  io.stdout("  --summary <text>    New summary");
  io.stdout("  --priority <p>      Priority (low, medium, high, critical)");
  io.stdout("  --estimate <size>   Estimate (XS, S, M, L, XL)");
  io.stdout("  --actor <name>      Actor name for history");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket subticket update PAP-120 ST-001 --status in-progress");
  io.stdout("  ticket subticket update PAP-120 ST-001 --assignee sinh");
}

function printSubticketCompleteHelp(io: Required<CliIo>): void {
  io.stdout("Usage: ticket subticket complete <parent-id> <sub-id>");
  io.stdout("");
  io.stdout("Mark a sub-ticket as done.");
  io.stdout("");
  io.stdout("Examples:");
  io.stdout("  ticket subticket complete PAP-120 ST-001");
}

function runSubTicketCommand(argv: string[], io: Required<CliIo>, store: TicketStore): number {
  const [subcommand, parentId, maybeSubId, ...rest] = argv;
  if (argv[0] === "--help" || argv[0] === "-h") {
    printTicketSubticketHelp(io);
    return 0;
  }
  if (!subcommand) return printError("ticket subticket requires subcommand", io);
  if (!parentId) return printError("ticket subticket requires parent id", io);
  if (subcommand === "create") {
    if (parentId === "--help" || parentId === "-h" || maybeSubId === "--help" || maybeSubId === "-h") {
      printSubticketCreateHelp(io);
      return 0;
    }
    const parsed = parseFlagPairs([maybeSubId, ...rest].filter((value): value is string => !!value), new Set(["--title", "--summary", "--assignee", "--priority", "--estimate", "--actor"]));
    if ("error" in parsed) return printError(parsed.error, io);
    const title = parsed.values["--title"];
    if (!title) return printError("--title is required", io);
    const titleResult = sanitizeTextInput(title);
    if (titleResult.removed > 0) io.stderr(`sanitized sub-ticket title: removed ${titleResult.removed} invalid character(s)`);
    const summaryRaw = parsed.values["--summary"] ?? "";
    const summaryResult = sanitizeTextInput(summaryRaw);
    if (summaryResult.removed > 0) io.stderr(`sanitized sub-ticket summary: removed ${summaryResult.removed} invalid character(s)`);
    const result = store.addSubTicket(parentId, { title: titleResult.sanitized, summary: summaryResult.sanitized, assignee: parsed.values["--assignee"] ?? "", priority: (parsed.values["--priority"] ?? "medium") as TicketPriority, estimate: (parsed.values["--estimate"] ?? "S") as Estimate }, parsed.values["--actor"] ?? "pa-core");
    io.stdout(`Created sub-ticket: ${result.subTicket.id}`);
    return 0;
  }
  if (subcommand === "list") {
    if (parentId === "--help" || parentId === "-h") {
      printSubticketListHelp(io);
      return 0;
    }
    const subTickets = store.listSubTickets(parentId);
    for (const sub of subTickets) io.stdout(`${sub.id.padEnd(18)} ${sub.status.padEnd(12)} ${sub.priority.padEnd(8)} ${sub.title}`);
    io.stdout(`Count: ${subTickets.length}`);
    return 0;
  }
  if (subcommand === "update") {
    if (parentId === "--help" || parentId === "-h" || maybeSubId === "--help" || maybeSubId === "-h") {
      printSubticketUpdateHelp(io);
      return 0;
    }
    const subTicketId = maybeSubId;
    if (!subTicketId) return printError("ticket subticket update requires sub-ticket id", io);
    const parsed = parseFlagPairs(rest, new Set(["--status", "--assignee", "--title", "--summary", "--priority", "--estimate", "--actor"]));
    if ("error" in parsed) return printError(parsed.error, io);
    const values = parsed.values;
    const input: { status?: SubTicketStatus; assignee?: string; title?: string; summary?: string; priority?: TicketPriority; estimate?: Estimate } = {};
    if (values["--status"]) input.status = values["--status"] as SubTicketStatus;
    if (values["--assignee"]) input.assignee = values["--assignee"];
    if (values["--title"]) {
      const titleResult = sanitizeTextInput(values["--title"]);
      if (titleResult.removed > 0) io.stderr(`sanitized sub-ticket title: removed ${titleResult.removed} invalid character(s)`);
      input.title = titleResult.sanitized;
    }
    if (values["--summary"]) {
      const summaryResult = sanitizeTextInput(values["--summary"]);
      if (summaryResult.removed > 0) io.stderr(`sanitized sub-ticket summary: removed ${summaryResult.removed} invalid character(s)`);
      input.summary = summaryResult.sanitized;
    }
    if (values["--priority"]) input.priority = values["--priority"] as TicketPriority;
    if (values["--estimate"]) input.estimate = values["--estimate"] as Estimate;
    const result = store.updateSubTicket(parentId, subTicketId, input, values["--actor"] ?? "pa-core");
    io.stdout(`Updated: ${result.subTicket.id}`);
    return 0;
  }
  if (subcommand === "complete") {
    if (parentId === "--help" || parentId === "-h" || maybeSubId === "--help" || maybeSubId === "-h") {
      printSubticketCompleteHelp(io);
      return 0;
    }
    const subTicketId = maybeSubId;
    if (!subTicketId) return printError("ticket subticket complete requires sub-ticket id", io);
    const result = store.updateSubTicket(parentId, subTicketId, { status: "done" }, "pa-core");
    io.stdout(`Completed: ${result.subTicket.id}`);
    return 0;
  }
  return printError(`Unknown ticket subticket subcommand: ${subcommand}`, io);
}

function parseFlagPairs(argv: string[], allowed: Set<string>, booleanFlags = new Set<string>()): { values: Record<string, string>; booleans: Set<string> } | { error: string } {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!allowed.has(flag)) return { error: `Unsupported option: ${flag}` };
    if (booleanFlags.has(flag)) {
      booleans.add(flag);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) return { error: `${flag} requires a value` };
    values[flag] = value;
    i += 1;
  }
  return { values, booleans };
}

function parseDocRefFlag(value: string): { path: string; type?: string; primary?: boolean } {
  const index = value.indexOf(":");
  if (index > 0 && !value.slice(0, index).includes("/")) return { type: value.slice(0, index), path: value.slice(index + 1) };
  return { path: value };
}

function parseLinkedBranchFlag(value: string): { repo: string; branch: string; sha?: string } {
  const parts = value.split("|");
  if (parts.length < 2) throw new Error(`Invalid --linked-branch format "${value}". Expected: repo|branch|sha`);
  return { repo: parts[0]!, branch: parts.length > 2 ? parts.slice(1, -1).join("|") : parts.slice(1).join("|"), sha: parts.length > 2 ? parts.at(-1) : undefined };
}

function parseLinkedCommitFlag(value: string): { repo: string; sha: string; message?: string; author?: string; timestamp?: string } {
  const parts = value.split("|");
  if (parts.length < 2) throw new Error(`Invalid --linked-commit format "${value}". Expected: repo|sha|message|author|timestamp`);
  return { repo: parts[0]!, sha: parts[1]!, message: parts[2], author: parts[3], timestamp: parts[4] };
}

function splitCsv(value: string | undefined): string[] {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function consumeJsonFlag(argv: string[]): { json: boolean } | { error: string } {
  const unsupported = argv.find((arg) => arg !== "--json");
  return unsupported ? { error: `Unsupported option: ${unsupported}` } : { json: argv.includes("--json") };
}

function printError(error: string, io: Required<CliIo>): number {
  io.stderr(error);
  return 1;
}
