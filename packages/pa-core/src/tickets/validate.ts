import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { getTeamsDir } from "../paths.js";

// Ported from PA tickets/validate.ts at frozen PA source on 2026-04-26.

const BARE_NAME_WHITELIST = ["sinh"];

export function getValidTeamNames(teamsDir = getTeamsDir()): Set<string> {
  const names = new Set<string>();
  if (!existsSync(teamsDir)) return names;
  for (const file of readdirSync(teamsDir).filter((entry) => entry.endsWith(".yaml"))) {
    try {
      const raw = yaml.load(readFileSync(resolve(teamsDir, file), "utf-8")) as Record<string, unknown>;
      if (typeof raw["name"] === "string" && raw["name"]) names.add(raw["name"]);
    } catch {
      // skip invalid team files
    }
  }
  return names;
}

export function validateAuthor(author: string, validTeams = getValidTeamNames()): void {
  if (BARE_NAME_WHITELIST.includes(author)) return;
  validateTeamQualifiedName(author, "author", validTeams);
}

export function validateAssignee(assignee: string, validTeams = getValidTeamNames()): void {
  if (BARE_NAME_WHITELIST.includes(assignee)) return;
  const slashIndex = assignee.indexOf("/");
  if (slashIndex === -1) {
    if (validTeams.has(assignee)) return;
    process.stderr.write(`Warning: Bare assignee '${assignee}' is deprecated. Use '<team>/${assignee}' format. Valid teams: ${[...validTeams].sort().join(", ")}\n`);
    return;
  }
  const teamPrefix = assignee.slice(0, slashIndex);
  if (!validTeams.has(teamPrefix)) throw new Error(`Invalid assignee '${assignee}'. Team '${teamPrefix}' not found. Valid teams: ${[...validTeams].sort().join(", ")}. Allowed bare names: ${BARE_NAME_WHITELIST.join(", ")}`);
}

export function matchAssignee(ticketAssignee: string, filterAssignee: string, validTeams = getValidTeamNames()): boolean {
  if (!ticketAssignee) return false;
  if (ticketAssignee === filterAssignee) return true;
  if (!filterAssignee.includes("/")) {
    if (validTeams.has(filterAssignee)) return ticketAssignee.startsWith(`${filterAssignee}/`);
    return ticketAssignee.endsWith(`/${filterAssignee}`);
  }
  return false;
}

function validateTeamQualifiedName(value: string, fieldName: string, validTeams: Set<string>): void {
  const slashIndex = value.indexOf("/");
  const team = slashIndex === -1 ? value : value.slice(0, slashIndex);
  if (!validTeams.has(team)) throw new Error(`Invalid ${fieldName} '${value}'. Team '${team}' not found. Valid teams: ${[...validTeams].sort().join(", ")}. Allowed bare names: ${BARE_NAME_WHITELIST.join(", ")}`);
}
