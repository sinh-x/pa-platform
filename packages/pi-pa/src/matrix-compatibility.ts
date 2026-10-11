import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { formatBoundedFiveFieldDiagnostic } from "@pa-platform/pa-core";

export type MatrixLayout = "plain-inline" | "bold-fenced";
export type MatrixProfile = "current" | "nixos";
export type MatrixFailureKind = "syntax" | "authority" | "semantic";

/** Parsing is not admission: no clause is verified and no command is executed here. */
export interface CompatibleMatrix {
  readonly authority: string;
  readonly digest: string;
  readonly layout: MatrixLayout;
  readonly profile: MatrixProfile;
  readonly matrixSource: string;
  readonly prerequisites: readonly string[];
  readonly environmentSection: string;
  readonly commands: readonly string[];
  readonly declaredCommandCount: number | undefined;
}

export class MatrixCompatibilityError extends Error {
  constructor(readonly kind: MatrixFailureKind, source: string, reason: string) {
    super(formatBoundedFiveFieldDiagnostic({
      condition: `review matrix ${kind} failure`,
      source,
      reason,
      correction: "supply one complete supported matrix with exact ordered sections and independently approved raw bytes",
      resumeAction: "reconcile matrix authority before admission; start no matrix command or reviewer",
    }));
    this.name = "MatrixCompatibilityError";
  }
}

const HEADING = "### Full Validation Matrix";
const LABELS = [
  "Matrix Source", "Matrix Authority", "Execution Owner", "Prerequisites", "Environment",
  "Commands (run in this exact order)", "Required Outputs and Artifacts", "Pass Criteria", "Matrix Rules",
] as const;
type Label = (typeof LABELS)[number];
interface Line { text: string; start: number; end: number; code: boolean }
interface Section { label: Label; layout: MatrixLayout; inline: string; body: string }

function fail(kind: MatrixFailureKind, source: string, reason: string): never {
  throw new MatrixCompatibilityError(kind, source, reason);
}

function decode(input: string | Uint8Array): string {
  let text: string;
  if (typeof input === "string") {
    text = input;
    if (Buffer.from(text, "utf8").toString("utf8") !== text) {
      fail("syntax", "matrix UTF-8", "input contains invalid Unicode; raw bytes cannot be preserved");
    }
  } else {
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input); }
    catch { fail("syntax", "matrix UTF-8", "input is not valid raw UTF-8"); }
  }
  if (text.includes("\r") || text.includes("\u0000") || text.includes("\ufeff")) {
    fail("syntax", "matrix UTF-8", "unsupported carriage return, NUL or BOM; no normalization is permitted");
  }
  return text;
}

/** Fence-aware structural scan. Command-code headings and labels are never authority. */
function scan(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let fence: { character: string; length: number } | undefined;
  for (const value of text.split("\n")) {
    const end = start + value.length + (start + value.length < text.length ? 1 : 0);
    const marker = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(value);
    const code = fence !== undefined || marker !== null;
    if (fence) {
      if (marker && marker[2]![0] === fence.character && marker[2]!.length >= fence.length && /^ *$/.test(marker[3]!)) fence = undefined;
    } else if (marker) {
      fence = { character: marker[2]![0]!, length: marker[2]!.length };
    }
    lines.push({ text: value, start, end, code });
    start = end;
  }
  if (fence) fail("syntax", "matrix fences", "unterminated code fence makes structural boundaries ambiguous");
  return lines;
}

function matrixHeadings(lines: readonly Line[]): Line[] {
  const candidates = lines.filter((line) => !line.code && /^\s*#{1,6}\s+Full\s+Validation\s+Matrix\b/.test(line.text));
  if (candidates.length === 0) fail("authority", "matrix boundary", "Full Validation Matrix heading is absent");
  if (candidates.length !== 1) fail("authority", "matrix boundary", "duplicate or ambiguous Full Validation Matrix headings");
  if (candidates[0]!.text !== HEADING) fail("syntax", "matrix boundary", "present matrix heading has unsupported syntax");
  return candidates;
}

/** Extract from a complete requirements document; require the evidenced level-2 terminal boundary. */
export function extractMatrixAuthority(input: string | Uint8Array): string {
  const text = decode(input);
  const lines = scan(text);
  const heading = matrixHeadings(lines)[0]!;
  const boundary = lines.find((line) => line.start > heading.start && !line.code && /^#{1,6} /.test(line.text));
  if (!boundary) fail("authority", "matrix boundary", "terminal Implementation Plan heading is absent");
  if (!/^## (?:[0-9]+\. )?Implementation Plan$/.test(boundary.text)) {
    fail("authority", "matrix boundary", "unexpected heading makes the raw authority boundary ambiguous or unsupported");
  }
  return text.slice(heading.start, boundary.start);
}

/** Parse only a bounded raw matrix (e.g. extractMatrixAuthority output), never arbitrary Markdown. */
export function parseMatrixCompatibility(input: string | Uint8Array): CompatibleMatrix {
  const authority = decode(input);
  const lines = scan(authority);
  const heading = matrixHeadings(lines)[0]!;
  if (heading.start !== 0) fail("authority", "matrix boundary", "raw matrix must begin at its unique exact heading");
  if (lines.some((line) => line.start > 0 && !line.code && /^#{1,6} /.test(line.text))) {
    fail("authority", "matrix boundary", "raw matrix contains an unexpected terminal or internal heading");
  }
  const sections: Section[] = [];
  let current: { label: Label; layout: MatrixLayout; inline: string; start: number } | undefined;
  let layout: MatrixLayout | undefined;
  for (const line of lines.slice(1)) {
    if (line.code) continue;
    const bold = /^\*\*([^*]+):\*\*(.*)$/.exec(line.text);
    const plain = /^([A-Za-z][^*]*):$/.exec(line.text);
    const match = bold ?? plain;
    if (match) {
      const label = match[1] as Label;
      if (!LABELS.includes(label)) fail("syntax", "matrix sections", "present section label is unsupported");
      const style: MatrixLayout = bold ? "bold-fenced" : "plain-inline";
      if (layout && layout !== style) fail("syntax", "matrix sections", "mixed plain and bold section layouts");
      if (sections.some((section) => section.label === label) || current?.label === label) {
        fail("authority", "matrix sections", "duplicate authoritative section");
      }
      if (current && LABELS.indexOf(label) <= LABELS.indexOf(current.label)) {
        fail("authority", "matrix sections", "authoritative sections are reordered");
      }
      if (current) sections.push({ ...current, body: authority.slice(current.start, line.start) });
      const inline = bold?.[2] ?? "";
      if (inline && (label !== "Matrix Source" || !/^ `[^`\n]+`$/.test(inline))) {
        fail("syntax", "matrix sections", "unsupported inline section content");
      }
      layout = style;
      current = { label, layout: style, inline, start: line.end };
    } else if (line.text && !current) {
      fail("syntax", "matrix sections", "unsupported content before the first authority section");
    } else if (/^\s*\**[A-Za-z][^:]*:/.test(line.text) || /^\s*\*\*/.test(line.text)) {
      fail("syntax", "matrix sections", "present section-like content has unsupported syntax");
    }
  }
  if (current) sections.push({ ...current, body: authority.slice(current.start) });
  const section = (label: Label): Section => {
    const value = sections.find((item) => item.label === label);
    if (!value) fail("authority", "matrix sections", `required ${label} section is absent`);
    return value;
  };
  const required: readonly Label[] = layout === "plain-inline"
    ? ["Matrix Source", "Matrix Authority", "Execution Owner", "Prerequisites", "Environment", "Commands (run in this exact order)", "Pass Criteria", "Matrix Rules"]
    : ["Matrix Source", "Prerequisites", "Environment", "Commands (run in this exact order)", "Required Outputs and Artifacts", "Pass Criteria"];
  for (const label of required) section(label);
  if (sections.some((value) => !required.includes(value.label))) {
    fail("syntax", "matrix sections", "present section is unsupported for the evidenced layout");
  }
  const source = section("Matrix Source");
  const prerequisites = bullets(section("Prerequisites"));
  const environmentSection = section("Environment").body;
  bullets(section("Environment"));
  const commandSection = section("Commands (run in this exact order)");
  const pass = section("Pass Criteria");
  const passLines = bullets(pass);
  for (const value of sections) {
    if (!["Matrix Source", "Prerequisites", "Environment", "Commands (run in this exact order)", "Pass Criteria"].includes(value.label)) bullets(value);
  }
  let matrixSource: string;
  if (source.inline) {
    if (source.body.split("\n").some((line) => line !== "")) fail("syntax", "Matrix Source", "inline source has additional ambiguous content");
    matrixSource = source.inline.slice(2, -1);
  } else {
    const values = bullets(source);
    const match = values.length === 1 ? /^`([^`]+)`(?: attached to [A-Z]+-[0-9]+ as the primary requirements document is the sole matrix authority\.)?$/.exec(values[0]!) : null;
    if (!match) fail("authority", "Matrix Source", "present source is malformed or ambiguous");
    matrixSource = match[1]!;
  }
  if (!/^agent-teams\/[A-Za-z0-9_./-]+\.md$/.test(matrixSource) || matrixSource.split("/").some((part) => part === ".." || part === "." || part === "")) {
    fail("authority", "Matrix Source", "source is not one exact AI-usage-relative artifact path");
  }
  const commands = parseCommands(commandSection.body, layout!);
  const counts = passLines.filter((line) => line.includes("Commands Total:"));
  let declaredCommandCount: number | undefined;
  if (counts.length > 1) fail("authority", "matrix command count", "duplicate or ambiguous declared command counts");
  if (counts.length === 1) {
    const match = /^Commands Total: ([1-9][0-9]*)(?:\.|;|$)/.exec(counts[0]!);
    if (!match || !Number.isSafeInteger(Number(match[1]))) fail("syntax", "matrix command count", "present declared command count is unsupported");
    declaredCommandCount = Number(match[1]);
    if (declaredCommandCount !== commands.length) fail("authority", "matrix command count", "declared count disagrees with complete command extraction");
  }
  const profile = recognizeMatrixProfile(prerequisites);
  return Object.freeze({
    authority, digest: createHash("sha256").update(authority, "utf8").digest("hex"),
    layout: layout!, profile, matrixSource, prerequisites: Object.freeze(prerequisites),
    environmentSection, commands: Object.freeze(commands), declaredCommandCount,
  });
}

function bullets(section: Section): string[] {
  const values = section.body.split("\n").filter((line) => line !== "");
  if (section.inline || values.length === 0 || values.some((line) => !/^- \S.*$/.test(line))) {
    fail("syntax", section.label, "present section must contain complete nonempty bullet clauses; unsupported content cannot be ignored");
  }
  return values.map((line) => line.slice(2));
}

function parseCommands(body: string, layout: MatrixLayout): string[] {
  const lines = body.split("\n");
  const commands: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index++]!;
    if (line === "") continue;
    if (layout === "plain-inline") {
      const match = /^([1-9][0-9]*)\. `([^`]+)`$/.exec(line);
      if (!match || Number(match[1]) !== commands.length + 1 || !match[2]!.trim()) {
        fail("syntax", "matrix commands", "unsupported, mixed, empty or out-of-order inline command; extraction is incomplete");
      }
      commands.push(match[2]!);
    } else {
      const match = /^([1-9][0-9]*)\. \S.*$/.exec(line);
      if (!match || /^\d+\. `/.test(line) || Number(match[1]) !== commands.length + 1 || lines[index++] !== "```bash") {
        fail("syntax", "matrix commands", "unsupported, mixed or out-of-order described Bash command; extraction is incomplete");
      }
      const start = index;
      while (index < lines.length && lines[index] !== "```") index++;
      if (index === lines.length) fail("syntax", "matrix commands", "Bash command closing delimiter is absent or unsupported");
      const command = lines.slice(start, index++).join("\n");
      if (!command.trim()) fail("syntax", "matrix commands", "command is empty");
      commands.push(command);
    }
  }
  if (commands.length === 0) fail("syntax", "matrix commands", "present command section contains no complete commands");
  return commands;
}

const AUTHORIZATION_CLAUSE = "The trusted launcher has atomically consumed the one-use review authorization, rejected duplicate active review lineage, and supplied the complete explicit command environment. The authorization ID is excluded from command child environments, logs, activity progress, and ledger artifacts; it is supplied separately to the reviewer for exact objective, report, and registry agreement. No project command starts before these checks pass.";

/** Semantic classification only. These assertions require independent runtime verification later. */
export function recognizeMatrixProfile(prerequisites: readonly string[]): MatrixProfile {
  const current = [
    /^Linux `[^`]+`; canonical repository `[^`]+`; authenticated ticket checkout on `[^`]+`; clean tracked and untracked state; `HEAD` equals the launch-intent Feature SHA and descends from `[0-9a-f]{40}`\.$/,
    /^Node\.js `[^`]+`, pnpm `[^`]+` through Corepack, Pi `[^`]+`, Git, Bash, Nix, and the repository's existing installed dependencies including `[^`]+`(?:, `[^`]+`)*\.$/,
    /^The approved requirements artifact exists at `[^`]+` and its header, durable [A-Z]+-[0-9]+ approval comment, launch intent, and recomputed raw matrix digest agree exactly\.$/,
  ];
  const nixos = [
    /^The trusted PPA builder launcher has authenticated the [A-Z]+-[0-9]+ ticket checkout, created `[^`]+` from approved base `[0-9a-f]{40}`, persisted launch evidence, and produced a committed candidate with a clean worktree\.$/,
    /^Git, Bash, Python 3, ripgrep, Nix, and `ppa` are available in the authenticated checkout\.$/,
    /^Every declared local-path flake input exists at its recorded Git top level, full HEAD, and expected complete status; Nix daemon, upstream sources, caches, storage, and configured builders are available\.$/,
    /^The independent review launch has a valid one-use authorization, and no review is active for the same ticket and branch\.$/,
  ];
  const isCurrent = prerequisites.length === 4 && current.every((pattern, index) => pattern.test(prerequisites[index]!)) && prerequisites[3] === AUTHORIZATION_CLAUSE;
  const isNixos = prerequisites.length === 4 && nixos.every((pattern, index) => pattern.test(prerequisites[index]!));
  if (isCurrent === isNixos) fail("semantic", "matrix prerequisites", "present prerequisites are unsupported, mixed, reordered or unverifiable; no semantic profile is recognized");
  return isCurrent ? "current" : "nixos";
}
