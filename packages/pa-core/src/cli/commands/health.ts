import { formatPrimerHealthSummary, generateHealthReport, listHealthSnapshots, saveHealthSnapshot } from "../../health/index.js";
import type { HealthCategory } from "../../health/index.js";
import type { CliIo } from "../utils.js";
import { printError } from "../utils.js";

function parseHealthArgs(argv: string[]): { category?: HealthCategory; days?: number; since?: string; json?: boolean; save?: boolean; primerSummary?: boolean; history?: boolean } | { error: string } {
  const opts: { category?: HealthCategory; days?: number; since?: string; json?: boolean; save?: boolean; primerSummary?: boolean; history?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") opts.json = true;
    else if (arg === "--save") opts.save = true;
    else if (arg === "--primer-summary") opts.primerSummary = true;
    else if (arg === "--history") opts.history = true;
    else if (arg === "--days") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--days requires a value" };
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1) return { error: "--days must be a positive integer" };
      opts.days = days;
      i += 1;
    } else if (arg === "--since") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) return { error: "--since requires a value" };
      opts.since = value;
      i += 1;
    } else if (arg.startsWith("-")) return { error: `Unsupported health option: ${arg}` };
    else if (!opts.category) opts.category = arg as HealthCategory;
    else return { error: `Unexpected health argument: ${arg}` };
  }
  return opts;
}

export function runHealthCommand(argv: string[], io: Required<CliIo>): number {
  const parsed = parseHealthArgs(argv);
  if ("error" in parsed) return printError(parsed.error, io);
  if (parsed.history) {
    const snapshots = listHealthSnapshots(10);
    for (const snapshot of snapshots) io.stdout(`${snapshot.timestamp} ${String(snapshot.overallScore).padStart(3)}/100 ${snapshot.categories.map((category) => `${category.name}:${category.score}`).join(" ")}`);
    io.stdout(`Count: ${snapshots.length}`);
    return 0;
  }
  const report = generateHealthReport(parsed);
  if (parsed.save) saveHealthSnapshot(report);
  if (parsed.json) io.stdout(JSON.stringify(report));
  else if (parsed.primerSummary) io.stdout(formatPrimerHealthSummary(report));
  else {
    io.stdout(`Health: ${report.overallScore}/100 ${report.scoreLabel}`);
    for (const category of report.categories) io.stdout(`${category.name}: ${category.score} (${category.findings.length} findings)`);
  }
  return 0;
}
