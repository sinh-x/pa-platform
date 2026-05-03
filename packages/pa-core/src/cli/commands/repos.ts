import { listRepos } from "../../repos.js";
import { formatReposList } from "../formatters.js";
import type { CliIo } from "../utils.js";
import { consumeJsonFlag, printError } from "../utils.js";

export function runReposCommand(argv: string[], io: Required<CliIo>): number {
  const subcommand = argv[0];
  if (subcommand !== "list") {
    io.stderr(`Unknown repos subcommand: ${subcommand ?? ""}`.trim());
    io.stderr("Available subcommands: list");
    return 1;
  }
  const repos = listRepos();
  const json = consumeJsonFlag(argv.slice(1));
  if ("error" in json) return printError(json.error, io);
  io.stdout(json.json ? JSON.stringify(repos, null, 2) : formatReposList(repos));
  return 0;
}
