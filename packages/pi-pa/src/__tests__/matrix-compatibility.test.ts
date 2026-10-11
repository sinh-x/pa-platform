import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  extractMatrixAuthority, MatrixCompatibilityError, parseMatrixCompatibility, recognizeMatrixProfile,
  type MatrixFailureKind,
} from "../matrix-compatibility.js";

// The sole incident fixture is inert raw authority, never shell input or a live source read.
const goldenBytes = readFileSync(new URL("./fixtures/nx-055-matrix.md", import.meta.url));
const golden = goldenBytes.toString("utf8");
const GOLDEN_DIGEST = "2e9f872a54d6370f1e562ca25c986765b4c4879b194c77f150b30b27ee3f89ee";
const SOURCE = "agent-teams/requirements/artifacts/2026-10-01-nixos-upgrade-switch-gate.md";
const EXPECTED_COMMANDS = [
  'test "$PWD" = "$PA_WORKTREE_ROOT" && test "$(git rev-parse --show-toplevel)" = "$PA_WORKTREE_ROOT"',
  'test "$(git branch --show-current)" = "$PA_EXPECTED_BRANCH" && test "$(git merge-base "$PA_APPROVED_BASE_SHA" HEAD)" = "$PA_APPROVED_BASE_SHA"',
  'test "$(git diff --name-only "$PA_APPROVED_BASE_SHA"...HEAD | wc -l)" -eq 1 && test "$(git diff --name-only "$PA_APPROVED_BASE_SHA"...HEAD)" = "docs/workflows/nixos-upgrade.md"',
  'git diff --check "$PA_APPROVED_BASE_SHA"...HEAD',
  "test \"$(rg -l -F 'Ownership: NixOS flake upgrade orchestration and PPA checkout handoff.' AGENTS.md docs | wc -l)\" -eq 1 && rg -n -F 'Ownership: NixOS flake upgrade orchestration and PPA checkout handoff.' docs/workflows/nixos-upgrade.md",
  "python3 -c 'from pathlib import Path; s=Path(\"docs/workflows/nixos-upgrade.md\").read_text(); phases=[\"## Phase 1 — Preflight and plan validation\",\"## Phase 2 — Baseline and full lock refresh\",\"## Phase 3 — Non-privileged verification and diagnosis\",\"## Phase 4 — Sinh-approved repairs\",\"## Phase 5 — Sinh-run Drgnfly UAT\",\"## Phase 6 — Sinh-approved persistent switch\",\"## Phase 7 — Audit, rollback, and handoff\"]; p=[s.index(x) for x in phases]; assert p==sorted(p) and len(set(p))==7'",
  "python3 -c 'from pathlib import Path; s=Path(\"docs/workflows/nixos-upgrade.md\").read_text(); required=[\"sudo sys test\",\"sudo sys rebuild\",\"fresh explicit approval\",\"test approval does not approve persistent switch\",\"zero agent-run privileged commands\",\"active generation\",\"boot generation\",\"no mandatory reboot\",\"merge remains a separate later decision\",\"network recovery\"]; assert all(x in s for x in required)'",
  "nix flake check --no-write-lock-file --max-jobs 4 --cores 2",
  'test -z "$(git status --porcelain --untracked-files=all)"',
];
const prereqStart = golden.indexOf("Prerequisites:\n") + "Prerequisites:\n".length;
const prereqEnd = golden.indexOf("Environment:\n");
const nixosPrerequisites = golden.slice(prereqStart, prereqEnd).split("\n").filter(Boolean).map((line) => line.slice(2));
const currentPrerequisites = [
  "Linux `x86_64`; canonical repository `pa-platform`; authenticated ticket checkout on `feature/PAP-236-review-matrix-compatibility`; clean tracked and untracked state; `HEAD` equals the launch-intent Feature SHA and descends from `19819fa9a4ecf13ea9cc4f90bb7f2fd602582de9`.",
  "Node.js `v22.23.2`, pnpm `10.28.0` through Corepack, Pi `0.84.4`, Git, Bash, Nix, and the repository's existing installed dependencies including `better-sqlite3@13.0.3`, `tsx@4.21.0`.",
  "The approved requirements artifact exists at `/isolated/requirements.md` and its header, durable PAP-236 approval comment, launch intent, and recomputed raw matrix digest agree exactly.",
  "The trusted launcher has atomically consumed the one-use review authorization, rejected duplicate active review lineage, and supplied the complete explicit command environment. The authorization ID is excluded from command child environments, logs, activity progress, and ledger artifacts; it is supplied separately to the reviewer for exact objective, report, and registry agreement. No project command starts before these checks pass.",
];
function fenced(commands: readonly string[] = EXPECTED_COMMANDS, prerequisites: readonly string[] = nixosPrerequisites): string {
  return [
    "### Full Validation Matrix", "", `**Matrix Source:** \`${SOURCE}\``, "",
    "**Prerequisites:**", ...prerequisites.map((line) => `- ${line}`), "",
    "**Environment:**", "- `CI=true` — fixture only; environment validation belongs to phase 3.", "",
    "**Commands (run in this exact order):**", "",
    ...commands.flatMap((command, index) => [`${index + 1}. Inert command fixture:`, "```bash", command, "```", ""]),
    "**Required Outputs and Artifacts:**", "- Isolated parser output only.", "",
    "**Pass Criteria:**", `- Commands Total: ${commands.length}. Every extracted command is inert.`, "",
  ].join("\n");
}
function document(authority: string): string {
  return `# Isolated requirements fixture\n\n${authority}## 13. Implementation Plan\n\n- Out of parser scope.\n`;
}
function reject(input: string | Uint8Array, kind: MatrixFailureKind, reason: RegExp, extract = false): void {
  assert.throws(() => extract ? extractMatrixAuthority(input) : parseMatrixCompatibility(input), (error: unknown) => {
    assert.ok(error instanceof MatrixCompatibilityError);
    assert.equal(error.kind, kind);
    assert.match(error.message, reason);
    for (const label of ["Condition", "Source", "Reason", "Correction", "Resume Action"]) {
      assert.ok(error.message.includes(`${label}: `));
    }
    assert.ok(error.message.length <= 2000);
    assert.equal(Object.hasOwn(error, "commands"), false, "no partial extraction on failure");
    return true;
  });
}

test("unchanged NX-055 golden authority: exact raw bytes, digest, source and nine inert commands", () => {
  const result = parseMatrixCompatibility(goldenBytes);
  assert.equal(goldenBytes.length, 5751);
  assert.equal(createHash("sha256").update(goldenBytes).digest("hex"), GOLDEN_DIGEST);
  assert.equal(result.authority, golden);
  assert.deepEqual(Buffer.from(result.authority, "utf8"), goldenBytes);
  assert.equal(result.digest, GOLDEN_DIGEST);
  assert.equal(result.matrixSource, SOURCE);
  assert.equal(result.profile, "nixos");
  assert.equal(result.layout, "plain-inline");
  assert.equal(result.declaredCommandCount, 9);
  assert.deepEqual(result.commands, EXPECTED_COMMANDS);
  assert.deepEqual(result.prerequisites, nixosPrerequisites);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.commands) && Object.isFrozen(result.prerequisites));
});

test("both layouts preserve identical nine golden command contents/order and each layout's own raw authority", () => {
  for (const authority of [golden, fenced()]) {
    const bytes = Buffer.from(authority, "utf8");
    const extracted = extractMatrixAuthority(Buffer.from(document(authority)));
    assert.deepEqual(Buffer.from(extracted), bytes);
    const result = parseMatrixCompatibility(extracted);
    assert.equal(result.digest, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(result.commands, EXPECTED_COMMANDS);
    assert.equal(result.profile, "nixos");
  }
});

test("profiles are explicit semantic recognition, independent of layout or incident ticket naming", () => {
  const boldCurrent = fenced(["printf 'fixture only'"], currentPrerequisites).replace("CI=true", "CI=1");
  const plainCurrent = golden.slice(0, prereqStart) + currentPrerequisites.map((line) => `- ${line}`).join("\n") + "\n\n" + golden.slice(prereqEnd);
  for (const authority of [boldCurrent, plainCurrent]) assert.equal(parseMatrixCompatibility(authority).profile, "current");
  assert.equal(recognizeMatrixProfile(nixosPrerequisites.map((line) => line.replaceAll("NX-055", "SYNTH-123"))), "nixos");
  assert.equal(recognizeMatrixProfile(currentPrerequisites.map((line) => line.replaceAll("PAP-236", "NX-055"))), "current");
});

test("multiline command code, section-like text, headings, Unicode and whitespace are data", () => {
  const command = "  printf 'é 🦉'  \n\n### Full Validation Matrix\n## 13. Implementation Plan\nPrerequisites:\n**Environment:**\nCommands Total: 999\n1. `not a matrix command`\nprintf 'done'\n";
  const raw = fenced([command]);
  const result = parseMatrixCompatibility(extractMatrixAuthority(document(raw)));
  assert.equal(result.authority, raw);
  assert.deepEqual(result.commands, [command]);
  assert.equal(result.declaredCommandCount, 1);
});

test("inline command contents are not trimmed or rewritten", () => {
  const raw = golden.replace(EXPECTED_COMMANDS[0]!, "  printf 'é 🦉'  ");
  assert.equal(parseMatrixCompatibility(raw).commands[0], "  printf 'é 🦉'  ");
});

test("existing described-fence fixture shape supports colon descriptions and an undeclared count", () => {
  const raw = fenced(["printf 'fixture'"], currentPrerequisites).replace("- Commands Total: 1. Every extracted command is inert.", "- The command exits zero before reviewer spawn.");
  assert.equal(parseMatrixCompatibility(raw).declaredCommandCount, undefined);
});

const structuralCases: readonly [string, string, MatrixFailureKind, RegExp][] = [
  ["absent prerequisites", golden.replace(golden.slice(prereqStart - "Prerequisites:\n".length, prereqEnd), ""), "authority", /Prerequisites section is absent/],
  ["duplicate prerequisites", golden.replace("Environment:\n", "Prerequisites:\n- duplicate\n\nEnvironment:\n"), "authority", /duplicate/],
  ["mixed label layouts", golden.replace("Prerequisites:", "**Prerequisites:**"), "syntax", /mixed/],
  ["reordered sections", golden.replace("Prerequisites:", "Environment:").replace("Environment:\n- `PA_APPROVED", "Prerequisites:\n- `PA_APPROVED"), "authority", /reordered/],
  ["unsupported label", golden.replace("Prerequisites:", "Preconditions:"), "syntax", /unsupported/],
  ["present unsupported whitespace", golden.replace("Prerequisites:", "Prerequisites :"), "syntax", /unsupported/],
  ["present unsupported indent", golden.replace("Prerequisites:", " Prerequisites:"), "syntax", /unsupported/],
  ["present unsupported trailing space", golden.replace("Prerequisites:", "Prerequisites: "), "syntax", /unsupported/],
  ["present unsupported inline text", golden.replace("Prerequisites:", "Prerequisites: unknown"), "syntax", /unsupported/],
  ["empty prerequisites", golden.slice(0, prereqStart) + "\n" + golden.slice(prereqEnd), "syntax", /present section/],
  ["ignored prerequisite text", golden.replace(nixosPrerequisites[2]!, "unsupported prose").replace("- unsupported prose", "unsupported prose"), "syntax", /unsupported content/],
  ["absent environment", golden.replace("Environment:", ""), "authority", /Environment section is absent/],
  ["absent source", golden.replace("Matrix Source:", ""), "syntax", /before the first/],
  ["duplicate source", golden.replace("Matrix Authority:", "Matrix Source:"), "authority", /duplicate/],
  ["ambiguous source bullets", golden.replace("Matrix Authority:", "- `agent-teams/requirements/artifacts/other.md`\n\nMatrix Authority:"), "authority", /source is malformed or ambiguous/],
  ["traversing source", golden.replace(SOURCE, "agent-teams/requirements/../other.md"), "authority", /exact AI-usage-relative/],
  ["unknown section", golden.replace("Matrix Rules:", "Unknown Rules:"), "syntax", /unsupported/],
  ["empty pass criteria", fenced().replace(/- Commands Total: 9.*\n/, ""), "syntax", /present section/],
  ["count mismatch", golden.replace("Commands Total: 9", "Commands Total: 8"), "authority", /count disagrees/],
  ["duplicate count", fenced().replace("**Pass Criteria:**", "**Pass Criteria:**\n- Commands Total: 9."), "authority", /duplicate or ambiguous/],
  ["malformed count", golden.replace("Commands Total: 9", "Commands Total: nine"), "syntax", /declared command count is unsupported/],
  ["unsafe count", golden.replace("Commands Total: 9", "Commands Total: 99999999999999999999"), "syntax", /declared command count is unsupported/],
  ["stray command after extraction", fenced().replace("**Required Outputs and Artifacts:**", "printf 'not extracted'\n\n**Required Outputs and Artifacts:**"), "syntax", /extraction is incomplete/],
  ["stray command after pass criteria", fenced() + "10. `not extracted`\n", "syntax", /unsupported content/],
  ["mixed command forms", golden.replace('1. `' + EXPECTED_COMMANDS[0] + '`', "1. Described command\n```bash\ntrue\n```"), "syntax", /mixed/],
  ["inline command in fenced layout", fenced().replace("1. Inert command fixture:\n```bash\n" + EXPECTED_COMMANDS[0] + "\n```", "1. `true`"), "syntax", /mixed/],
  ["unsupported fence language", fenced().replace("```bash", "```sh"), "syntax", /extraction is incomplete/],
  ["unsupported fence delimiter", fenced().replaceAll("```", "~~~"), "syntax", /extraction is incomplete/],
  ["unterminated fence at EOF", fenced(["printf 'inert'"]).split("\n```\n")[0]!, "syntax", /unterminated/],
  ["missing intermediate closing fence", fenced().replace("\n```\n", "\n"), "syntax", /extraction is incomplete/],
  ["empty fenced command", fenced([""]), "syntax", /command is empty/],
  ["empty inline command", golden.replace(EXPECTED_COMMANDS[0]!, ""), "syntax", /empty/],
  ["missing command number", golden.replace("2. `", "3. `"), "syntax", /out-of-order/],
  ["duplicate command number", fenced().replace("2. Inert", "1. Inert"), "syntax", /out-of-order/],
  ["zero command number", fenced().replace("1. Inert", "0. Inert"), "syntax", /out-of-order/],
  ["trailing command annotation", golden.replace("1. `" + EXPECTED_COMMANDS[0] + "`", "1. `" + EXPECTED_COMMANDS[0] + "` ignored"), "syntax", /extraction is incomplete/],
  ["unsupported command-bearing environment", golden.replace("Environment:\n", "Environment:\n```bash\ntrue\n```\n"), "syntax", /unsupported content/],
  ["CRLF rejected not normalized", golden.replaceAll("\n", "\r\n"), "syntax", /no normalization/],
  ["BOM rejected not stripped", "\ufeff" + golden, "syntax", /no normalization/],
  ["raw unexpected heading", golden + "## 13. Implementation Plan\n", "authority", /unexpected/],
  ["duplicate raw heading", golden + "### Full Validation Matrix\n", "authority", /duplicate or ambiguous/],
  ["present unsupported matrix heading", golden.replace("### Full Validation Matrix", "## Full Validation Matrix"), "syntax", /present matrix heading/],
  ["present unsupported heading spacing", golden.replace("Full Validation", "Full  Validation"), "syntax", /present matrix heading/],
];
for (const [name, raw, kind, reason] of structuralCases) test(name, () => reject(raw, kind, reason));

for (const label of ["Matrix Source", "Prerequisites", "Environment", "Commands (run in this exact order)", "Required Outputs and Artifacts", "Pass Criteria"]) {
  test(`duplicate bold ${label}`, () => reject(fenced().replace(`**${label}:**`, `**${label}:**\n- duplicate\n**${label}:**`), "authority", /duplicate/));
}

for (const [name, prerequisites] of [
  ["unsupported prose still present", ["NX-055 prerequisites are satisfied"]],
  ["missing semantic inventory", nixosPrerequisites.filter((_, index) => index !== 2)],
  ["mixed semantic profiles", [currentPrerequisites[0]!, ...nixosPrerequisites.slice(1)]],
  ["reordered semantic clauses", [nixosPrerequisites[1]!, nixosPrerequisites[0]!, ...nixosPrerequisites.slice(2)]],
  ["extra unverified clause", [...currentPrerequisites, "Everything else is approved."]],
  ["incomplete inventory prose", nixosPrerequisites.map((line) => line.replace(", storage, and configured builders", ""))],
] as const) {
  test(name, () => reject(fenced(["printf 'inert'"], prerequisites), "semantic", /present prerequisites are unsupported/));
}

for (const [raw, labels, bold] of [
  [golden, ["Matrix Source", "Matrix Authority", "Execution Owner", "Prerequisites", "Environment", "Commands (run in this exact order)", "Pass Criteria", "Matrix Rules"], false],
  [fenced(), ["Matrix Source", "Prerequisites", "Environment", "Commands (run in this exact order)", "Required Outputs and Artifacts", "Pass Criteria"], true],
] as const) {
  for (const [index, label] of labels.entries()) {
    const marker = (value: string): string => bold ? `**${value}:**` : `${value}:`;
    const start = raw.indexOf(marker(label));
    const end = index + 1 < labels.length ? raw.indexOf(marker(labels[index + 1]!)) : raw.length;
    test(`absent complete ${bold ? "bold" : "plain"} ${label} section`, () => {
      reject(raw.slice(0, start) + raw.slice(end), "authority", /section is absent/);
    });
    if (!bold) test(`duplicate plain ${label}`, () => {
      reject(raw.slice(0, start) + marker(label) + "\n- duplicate\n" + raw.slice(start), "authority", /duplicate/);
    });
  }
}

test("parsed assertions never confer verified admission or execution evidence", () => {
  const result = parseMatrixCompatibility(golden);
  assert.equal(Object.hasOwn(result, "admission"), false);
  assert.equal(Object.hasOwn(result, "verified"), false);
  assert.equal(Object.hasOwn(result, "authorizationId"), false);
});

test("invalid UTF-8 and lone surrogate fail without reencoding replacement characters", () => {
  reject(Buffer.from([0xff]), "syntax", /not valid raw UTF-8/);
  reject(golden + "\ud800", "syntax", /invalid Unicode/);
});

test("complete document boundaries are unique, ordered and fence-aware", () => {
  reject("# no matrix\n", "authority", /heading is absent/, true);
  reject(document(golden) + document(golden), "authority", /duplicate or ambiguous/, true);
  reject(golden, "authority", /terminal.*absent/, true);
  reject(document(golden).replace(/^## 13\. Implementation Plan$/m, "### Unexpected"), "authority", /ambiguous or unsupported/, true);
  reject(document(golden).replace(/^## 13\. Implementation Plan$/m, "## 13. Implementation Plan "), "authority", /ambiguous or unsupported/, true);
  const prefix = "# fixture\n\n```text\n### Full Validation Matrix\n```\n\n";
  assert.equal(extractMatrixAuthority(prefix + document(golden)), golden);
});

test("diagnostics remain five-field bounded without reflecting huge untrusted content", () => {
  const huge = fenced(["printf 'inert'"], ["x".repeat(100_000)]);
  reject(huge, "semantic", /present prerequisites/);
  assert.throws(() => recognizeMatrixProfile([]), MatrixCompatibilityError);
});
