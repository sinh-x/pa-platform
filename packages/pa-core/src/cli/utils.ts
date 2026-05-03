import type { DeploymentStatus } from "../types.js";

export interface CliIo {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export function normalizeIo(io: CliIo = {}): Required<CliIo> {
  return { stdout: io.stdout ?? ((text) => process.stdout.write(`${text}\n`)), stderr: io.stderr ?? ((text) => process.stderr.write(`${text}\n`)) };
}

export function printError(error: string, io: Required<CliIo>): number {
  io.stderr(error);
  return 1;
}

export function consumeJsonFlag(argv: string[]): { json: boolean } | { error: string } {
  const unsupported = argv.find((arg) => arg !== "--json");
  return unsupported ? { error: `Unsupported option: ${unsupported}` } : { json: argv.includes("--json") };
}

export function parseFlagPairs(argv: string[], allowed: Set<string>, booleanFlags = new Set<string>()): { values: Record<string, string>; booleans: Set<string> } | { error: string } {
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

export function splitCsv(value: string | undefined): string[] {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

export function parseRatingOptions(values: Record<string, string>): { rating?: { source: "agent" | "system" | "user"; overall: number; productivity?: number; quality?: number; efficiency?: number; insight?: number } } | { error: string } {
  if (Object.keys(values).length === 0) return {};
  const source = values["--rating-source"] ?? "agent";
  if (source !== "agent" && source !== "system" && source !== "user") return { error: "--rating-source must be agent, system, or user" };
  const rating: { source: "agent" | "system" | "user"; overall: number; productivity?: number; quality?: number; efficiency?: number; insight?: number } = { source, overall: numberRating(values["--rating-overall"] ?? "0") };
  for (const [flag, key] of [["--rating-productivity", "productivity"], ["--rating-quality", "quality"], ["--rating-efficiency", "efficiency"], ["--rating-insight", "insight"]] as const) {
    if (values[flag] !== undefined) rating[key] = numberRating(values[flag]);
  }
  for (const value of [rating.overall, rating.productivity, rating.quality, rating.efficiency, rating.insight]) if (value !== undefined && (Number.isNaN(value) || value < 0 || value > 5)) return { error: "Rating values must be between 0 and 5" };
  return { rating };
}

function numberRating(value: string): number {
  return Number.parseFloat(value);
}

export function parseLimitOnly(argv: string[], context: string): { limit?: number } | { error: string } {
  const opts: { limit?: number } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg !== "--limit") return { error: `Unsupported ${context} option: ${arg}` };
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) return { error: "--limit requires a value" };
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1) return { error: "--limit must be a positive integer" };
    opts.limit = limit;
    i += 1;
  }
  return opts;
}

export function groupBy<T>(values: T[], keyFn: (value: T) => string): Array<[string, T[]]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) grouped.set(keyFn(value), [...(grouped.get(keyFn(value)) ?? []), value]);
  return [...grouped.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDeploymentStatus(value: string): value is DeploymentStatus["status"] {
  return ["running", "success", "partial", "failed", "crashed", "dead", "unknown"].includes(value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function localDateFn(timestamp: string | Date): string {
  if (typeof timestamp === "string") {
    return new Date(timestamp).toLocaleDateString("en-CA");
  }
  return timestamp.toLocaleDateString("en-CA");
}
