import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listRepos, resolveProjectFromCwd } from "../../repos.js";
import { readGuardedLocalTextFile } from "../../sensitive-patterns.js";
import { TicketStore } from "../../tickets/index.js";
import { nowUtc } from "../../time.js";
import type { CreateTicketInput, Estimate, SubTicketStatus, TicketPriority, TicketStatus, TicketType } from "../../tickets/index.js";
import type { CliIo } from "../utils.js";
import { formatTicketList, formatTicketShow } from "../formatters.js";

export function runTicketCommand(argv: string[], io: Required<CliIo>): number {
  const [subcommand, ...rest] = argv;
  const store = new TicketStore();
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
    const ticket = store.create(parsed.input, parsed.actor);
    io.stdout(`Created ${ticket.id}: ${ticket.title}`);
    return 0;
  }
  if (subcommand === "update") {
    const id = rest[0];
    if (!id) return printError("ticket update requires id", io);
    const parsed = parseTicketUpdateArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
    const ticket = store.update(id, parsed.input, parsed.actor);
    io.stdout(`Updated ${ticket.id}: ${ticket.status}`);
    return 0;
  }
  if (subcommand === "comment") {
    const id = rest[0];
    if (!id) return printError("ticket comment requires id", io);
    const parsed = parseTicketCommentArgs(rest.slice(1));
    if ("error" in parsed) return printError(parsed.error, io);
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
    const id = rest[0];
    if (!id) return printError("ticket delete requires id", io);
    const opts = parseTicketDeleteArgs(rest.slice(1));
    if ("error" in opts) return printError(opts.error, io);
    if (opts.force && !opts.yes) return printError("--force requires --yes in pa-core non-interactive mode", io);
    store.delete(id, opts.actor, opts.force);
    io.stdout(opts.force ? `Deleted (hard): ${id}` : `Deleted (soft): ${id} (status -> cancelled)`);
    return 0;
  }
  if (subcommand === "check-refs") return runTicketCheckRefs(rest, io, store);
  if (subcommand === "subticket") return runSubTicketCommand(rest, io, store);
  io.stderr(`Unknown ticket subcommand: ${subcommand ?? ""}`.trim());
  io.stderr("Available subcommands: list, show, create, update, attach, comment, move, delete, check-refs, subticket");
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

function parseTicketCreateArgs(argv: string[]): { input: CreateTicketInput; actor: string } | { error: string } {
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
  return { actor, input: { project, title: values["--title"]!, summary: values["--summary"] ?? "", description: values["--description"] ?? "", status: (values["--status"] ?? "idea") as TicketStatus, priority: values["--priority"] as TicketPriority, type: values["--type"] as TicketType, assignee: values["--assignee"]!, estimate: values["--estimate"] as Estimate, from: values["--from"] ?? "", to: values["--to"] ?? "", tags: splitCsv(values["--tags"]), blockedBy: [], doc_refs: docRef ? [{ type: docRef.type ?? "attachment", path: docRef.path, primary: true, addedAt: nowUtc(), addedBy: actor }] : [], comments: [] } };
}

function availableProjectGuidance(): string {
  const available = listRepos().filter((repo) => repo.prefix).map((repo) => repo.name).join(", ");
  return available ? ` Available projects: ${available}` : "";
}

function parseTicketUpdateArgs(argv: string[]): { input: { status?: TicketStatus; assignee?: string; priority?: TicketPriority; tags?: string[]; blockedBy?: string[]; estimate?: Estimate; add_doc_ref?: { path: string; type?: string; primary?: boolean }; remove_doc_ref?: string; add_linked_branch?: { repo: string; branch: string; sha?: string }; remove_linked_branch?: string; add_linked_commit?: { repo: string; sha: string; message?: string; author?: string; timestamp?: string }; remove_linked_commit?: string }; actor: string } | { error: string } {
  const result = parseTicketUpdateFlagPairs(argv);
  if ("error" in result) return result;
  const values = result.values;
  const input: { status?: TicketStatus; assignee?: string; priority?: TicketPriority; tags?: string[]; blockedBy?: string[]; estimate?: Estimate; add_doc_ref?: { path: string; type?: string; primary?: boolean }; remove_doc_ref?: string; add_linked_branch?: { repo: string; branch: string; sha?: string }; remove_linked_branch?: string; add_linked_commit?: { repo: string; sha: string; message?: string; author?: string; timestamp?: string }; remove_linked_commit?: string } = {};
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
  return { input, actor: values["--actor"] ?? "pa-core" };
}

function parseTicketCommentArgs(argv: string[]): { author: string; content: string } | { error: string } {
  const result = parseFlagPairs(argv, new Set(["--author", "--content", "--content-file"]));
  if ("error" in result) return result;
  if (!result.values["--author"]) return { error: "--author is required" };
  if (result.values["--content"] && result.values["--content-file"]) return { error: "Use only one of --content or --content-file" };
  if (!result.values["--content"] && !result.values["--content-file"]) return { error: "one of --content or --content-file is required" };
  const content = result.values["--content-file"] ? readGuardedLocalTextFile(result.values["--content-file"]!) : result.values["--content"]!;
  return { author: result.values["--author"]!, content };
}

function parseTicketUpdateFlagPairs(argv: string[]): { values: Record<string, string>; booleans: Set<string> } | { error: string } {
  const valueFlags = new Set(["--status", "--assignee", "--priority", "--tags", "--blocked-by", "--estimate", "--doc-ref", "--remove-doc-ref", "--linked-branch", "--linked-commit", "--remove-linked-branch", "--remove-linked-commit", "--actor"]);
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

function runSubTicketCommand(argv: string[], io: Required<CliIo>, store: TicketStore): number {
  const [subcommand, parentId, maybeSubId, ...rest] = argv;
  if (!subcommand) return printError("ticket subticket requires subcommand", io);
  if (!parentId) return printError("ticket subticket requires parent id", io);
  if (subcommand === "create") {
    const parsed = parseFlagPairs([maybeSubId, ...rest].filter((value): value is string => !!value), new Set(["--title", "--summary", "--assignee", "--priority", "--estimate", "--actor"]));
    if ("error" in parsed) return printError(parsed.error, io);
    const title = parsed.values["--title"];
    if (!title) return printError("--title is required", io);
    const result = store.addSubTicket(parentId, { title, summary: parsed.values["--summary"] ?? "", assignee: parsed.values["--assignee"] ?? "", priority: (parsed.values["--priority"] ?? "medium") as TicketPriority, estimate: (parsed.values["--estimate"] ?? "S") as Estimate }, parsed.values["--actor"] ?? "pa-core");
    io.stdout(`Created sub-ticket: ${result.subTicket.id}`);
    return 0;
  }
  if (subcommand === "list") {
    const subTickets = store.listSubTickets(parentId);
    for (const sub of subTickets) io.stdout(`${sub.id.padEnd(18)} ${sub.status.padEnd(12)} ${sub.priority.padEnd(8)} ${sub.title}`);
    io.stdout(`Count: ${subTickets.length}`);
    return 0;
  }
  if (subcommand === "update" || subcommand === "complete") {
    const subTicketId = maybeSubId;
    if (!subTicketId) return printError(`ticket subticket ${subcommand} requires sub-ticket id`, io);
    const parsed: { values: Record<string, string> } | { error: string } = subcommand === "complete" ? { values: { "--status": "done" } } : parseFlagPairs(rest, new Set(["--status", "--assignee", "--title", "--summary", "--priority", "--estimate", "--actor"]));
    if ("error" in parsed) return printError(parsed.error, io);
    const values = parsed.values;
    const input: { status?: SubTicketStatus; assignee?: string; title?: string; summary?: string; priority?: TicketPriority; estimate?: Estimate } = {};
    if (values["--status"]) input.status = values["--status"] as SubTicketStatus;
    if (values["--assignee"]) input.assignee = values["--assignee"];
    if (values["--title"]) input.title = values["--title"];
    if (values["--summary"]) input.summary = values["--summary"];
    if (values["--priority"]) input.priority = values["--priority"] as TicketPriority;
    if (values["--estimate"]) input.estimate = values["--estimate"] as Estimate;
    const result = store.updateSubTicket(parentId, subTicketId, input, values["--actor"] ?? "pa-core");
    io.stdout(`${subcommand === "complete" ? "Completed" : "Updated"}: ${result.subTicket.id}`);
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
