import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadTeamConfig } from "../../teams/index.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

function isRepeatValue(value: string): value is "hourly" | "daily" | "weekly" | "monthly" {
  return value === "hourly" || value === "daily" || value === "weekly" || value === "monthly";
}

function parseScheduleArgs(argv: string[]): { spec: string; repeat: "hourly" | "daily" | "weekly" | "monthly"; times: string[]; command: string; dryRun: boolean } | { error: string } {
  const opts = { repeat: "daily" as "hourly" | "daily" | "weekly" | "monthly", times: [] as string[], command: defaultPaCommand(), dryRun: false };
  let spec = "";
  let positionalRepeatSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--repeat") {
      const value = argv[i + 1];
      if (value !== "hourly" && value !== "daily" && value !== "weekly" && value !== "monthly") return { error: "--repeat must be hourly, daily, weekly, or monthly" };
      opts.repeat = value;
      i += 1;
    } else if (arg === "--time") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--time requires a value" };
      opts.times.push(value);
      i += 1;
    } else if (arg === "--command") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--command requires a value" };
      opts.command = value;
      i += 1;
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("-")) return { error: `Unsupported schedule option: ${arg}` };
    else if (!spec) spec = arg;
    else if (!positionalRepeatSeen && isRepeatValue(arg)) {
      opts.repeat = arg;
      positionalRepeatSeen = true;
    }
    else opts.times.push(arg);
  }
  if (!spec) return { error: "schedule requires spec" };
  return { spec, repeat: opts.repeat, times: opts.times.length > 0 ? opts.times : ["09:00"], command: opts.command, dryRun: opts.dryRun };
}

function parseRemoveTimerArgs(argv: string[]): { name: string; dryRun: boolean; yes: boolean } | { error: string } {
  let name = "";
  let dryRun = false;
  let yes = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--yes") yes = true;
    else if (arg.startsWith("-")) return { error: `Unsupported remove-timer option: ${arg}` };
    else if (!name) name = arg;
    else return { error: `Unexpected remove-timer argument: ${arg}` };
  }
  return name ? { name, dryRun, yes } : { error: "remove-timer requires timer name" };
}

function resolveSchedule(spec: string, repeat: "hourly" | "daily" | "weekly" | "monthly", times: string[], command: string): { unitName: string; description: string; execCommand: string; onCalendarLines: string[]; timeDisplay: string } | { error: string } {
  let unitName: string;
  let description: string;
  let execCommand: string;
  if (spec === "signal:collect") {
    unitName = "pa-signal-collect";
    description = "personal-assistant signal collect";
    execCommand = `${command} signal collect`;
    return { unitName, description, execCommand, onCalendarLines: ["*:0/2:00"], timeDisplay: " every 2 hours" };
  }
  if (spec.startsWith("daily:")) {
    const mode = spec.slice("daily:".length);
    if (!mode || !["plan", "progress", "end"].includes(mode)) return { error: `Invalid daily mode '${mode}'. Use: plan | progress | end` };
    unitName = `pa-daily-${mode}`;
    description = `personal-assistant planner ${mode}`;
    execCommand = `${command} deploy planner --mode ${mode} --background`;
  } else if (spec.includes(":")) {
    const [team, mode] = spec.split(":");
    if (!team || !mode) return { error: `Invalid team:mode syntax '${spec}'. Expected <team>:<mode>.` };
    try {
      loadTeamConfig(team);
    } catch {
      return { error: `Team not found: ${team}` };
    }
    unitName = `pa-${team}-${mode}`;
    description = `personal-assistant ${team}:${mode}`;
    execCommand = `${command} deploy ${team} --mode ${mode} --background`;
  } else {
    try {
      loadTeamConfig(spec);
    } catch {
      return { error: `Team not found: ${spec}` };
    }
    unitName = `pa-${spec}`;
    description = `personal-assistant deploy: ${spec}`;
    execCommand = `${command} deploy ${spec} --background`;
  }
  const onCalendarLines = times.map((time) => calendarLine(repeat, time));
  const invalid = onCalendarLines.find((line) => line.startsWith("Error:"));
  if (invalid) return { error: invalid };
  return { unitName, description, execCommand, onCalendarLines, timeDisplay: times.map((time) => ` ${time}`).join("") };
}

function calendarLine(repeat: "hourly" | "daily" | "weekly" | "monthly", time: string): string {
  if (!/^\d{1,2}:\d{2}$/.test(time)) return `Error: Invalid time format '${time}'. Expected HH:MM.`;
  const [hour, min] = time.split(":");
  if (repeat === "hourly") return "hourly";
  if (repeat === "daily") return `*-*-* ${hour}:${min}:00`;
  if (repeat === "weekly") return `Mon *-*-* ${hour}:${min}:00`;
  return `*-*-01 ${hour}:${min}:00`;
}

function buildServiceUnit(description: string, execCommand: string): string {
  return `[Unit]\nDescription=${description}\n\n[Service]\nType=oneshot\nExecStart=${execCommand}\nKillMode=process\nEnvironment=HOME=${homedir()}\n`;
}

function buildTimerUnit(description: string, repeat: string, timeDisplay: string, onCalendarLines: string[]): string {
  return `[Unit]\nDescription=${description} (${repeat}${timeDisplay ? ` at${timeDisplay}` : ""})\n\n[Timer]\n${onCalendarLines.map((line) => `OnCalendar=${line}`).join("\n")}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
}

function defaultPaCommand(): string {
  if (process.env["PA_COMMAND"]) return process.env["PA_COMMAND"]!;
  if (process.env["PA_CORE_BIN"]) return process.env["PA_CORE_BIN"]!;
  if (process.env["PA_BIN"]) return resolve(process.env["PA_BIN"]!, "pa");
  return "pa-core";
}

function execSystemctl(args: string[]): void {
  execFileSync("systemctl", args, { stdio: "ignore" });
}

function tryExecSystemctl(args: string[]): void {
  try {
    execSystemctl(args);
  } catch {
    // The timer may not exist or may already be stopped.
  }
}

export function runScheduleCommand(argv: string[], io: Required<CliIo>): number {
  const parsed = parseScheduleArgs(argv);
  if ("error" in parsed) return printError(parsed.error, io);
  const resolved = resolveSchedule(parsed.spec, parsed.repeat, parsed.times, parsed.command);
  if ("error" in resolved) return printError(resolved.error, io);
  const systemdDir = resolve(process.env["XDG_CONFIG_HOME"] ?? resolve(homedir(), ".config"), "systemd/user");
  const servicePath = resolve(systemdDir, `${resolved.unitName}.service`);
  const timerPath = resolve(systemdDir, `${resolved.unitName}.timer`);
  if (!parsed.dryRun) {
    mkdirSync(systemdDir, { recursive: true });
    writeFileSync(servicePath, buildServiceUnit(resolved.description, resolved.execCommand));
    writeFileSync(timerPath, buildTimerUnit(resolved.description, parsed.repeat, resolved.timeDisplay, resolved.onCalendarLines));
    execSystemctl(["--user", "daemon-reload"]);
    execSystemctl(["--user", "enable", "--now", `${resolved.unitName}.timer`]);
  }
  io.stdout(`${parsed.dryRun ? "Would schedule" : "Scheduled"}: ${resolved.unitName} (${parsed.repeat}${resolved.timeDisplay ? ` at${resolved.timeDisplay}` : ""})`);
  io.stdout(`Timer: ${resolved.unitName}.timer`);
  io.stdout(`Service: ${servicePath}`);
  return 0;
}

export function runRemoveTimerCommand(argv: string[], io: Required<CliIo>): number {
  const parsed = parseRemoveTimerArgs(argv);
  if ("error" in parsed) return printError(parsed.error, io);
  if (!parsed.dryRun && !parsed.yes) return printError("remove-timer is destructive; rerun with --yes to confirm", io);
  const unitName = parsed.name.startsWith("pa-") ? parsed.name : `pa-${parsed.name}`;
  const systemdDir = resolve(process.env["XDG_CONFIG_HOME"] ?? resolve(homedir(), ".config"), "systemd/user");
  const timerPath = resolve(systemdDir, `${unitName}.timer`);
  const servicePath = resolve(systemdDir, `${unitName}.service`);
  if (!parsed.dryRun) {
    io.stderr(`Removing timer ${unitName}...`);
    tryExecSystemctl(["--user", "stop", `${unitName}.timer`]);
    tryExecSystemctl(["--user", "disable", `${unitName}.timer`]);
    if (existsSync(timerPath)) unlinkSync(timerPath);
    if (existsSync(servicePath)) unlinkSync(servicePath);
    execSystemctl(["--user", "daemon-reload"]);
  }
  io.stdout(`${parsed.dryRun ? "Would remove" : "Removed"} timer: ${unitName}`);
  return 0;
}
