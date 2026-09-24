import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  classifyOutputTarget,
  classifyPathOperand,
  classifyShellCommand,
  evaluateSafetyPolicy,
  formatTrashMoveGuidance,
  isBlockedFilePath,
  isDestructiveCommand,
} from "../index.js";

const legacyGroup7LoggingPipeline = `bash -lc 'set -euo pipefail; mkdir -p "$PA_DEPLOYMENT_DIR/evidence"; env -u PA_PI_SQLITE_NATIVE_BINDING -u PA_REQUIRE_PI_SQLITE_NATIVE_BINDING PAP167_REAL_PI="$(command -v pi)" PAP183_EXPECTED_PI_NODE_VERSION=v24.19.0 PAP176_INSTALLED_EVIDENCE="$PA_DEPLOYMENT_DIR/evidence/pap-183-installed-teardown.json" bash scripts/nix-store-output-smoke.sh 2>&1 | tee "$PA_DEPLOYMENT_DIR/evidence/pap-183-nix-smoke.log"'`;
const bootstrapCompatibleGroup7Command = `bash -lc 'set -euo pipefail; env -u PA_PI_SQLITE_NATIVE_BINDING -u PA_REQUIRE_PI_SQLITE_NATIVE_BINDING PAP167_REAL_PI="$(command -v pi)" PAP183_EXPECTED_PI_NODE_VERSION=v24.19.0 PAP176_INSTALLED_EVIDENCE="$PA_DEPLOYMENT_DIR/evidence/pap-183-installed-teardown.json" bash scripts/nix-store-output-smoke.sh --log-file "$PA_DEPLOYMENT_DIR/evidence/pap-183-nix-smoke.log"'`;
const installedBaselineRedirectPattern = String.raw`[^>]\s*>:?\s*\S`;
const revisedGroup1Command = [
  "bash -euo pipefail <<'PAP183_PREFLIGHT'",
  "repo_root=/home/sinh/git-repos/sinh-x/tools/pa-platform",
  "base=00260cbd975cc9256a1bab685e4b035428b4d563",
  "matrix_source=agent-teams/requirements/artifacts/2026-09-11-pap-183-safety-compatible-validation-matrix-revision.md",
  ": \"${PA_DEPLOYMENT_ID:?}\" \"${PA_DEPLOYMENT_DIR:?}\" \"${PA_ACTIVITY_LOG:?}\" \"${PA_REPO:?}\" \"${PA_TICKET_ID:?}\"",
  "[[ \"$PA_DEPLOYMENT_ID\" =~ ^d-[0-9a-f]{6}$ ]]",
  "test \"$PA_DEPLOYMENT_DIR\" = \"/home/sinh/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID\"",
  "test \"$PA_ACTIVITY_LOG\" = \"$PA_DEPLOYMENT_DIR/activity.jsonl\"",
  "primer=$PA_DEPLOYMENT_DIR/primer.md",
  "test -f \"$primer\"",
  "mapfile -t binding_lines < <(",
  "  awk '",
  "    BEGIN { terminator = \"<deployment-context\" sprintf(\"%c\", 62) }",
  "    $0 == \"## Additional Instructions\" && !seen { seen=1; inside=1; next }",
  "    inside && $0 == terminator { exit }",
  "    inside && index($0, \"PAP183_REVIEW_BINDING_V1|\") == 1 { print }",
  "  ' \"$primer\"",
  ")",
  "test \"${#binding_lines[@]}\" -eq 1",
  "binding_line=${binding_lines[0]}",
  "IFS='|' read -r binding_version repo_field root_field ticket_field branch_field candidate_field matrix_field extra <<<\"$binding_line\"",
  "test -z \"${extra:-}\"",
  "test \"$binding_version\" = PAP183_REVIEW_BINDING_V1",
  "test \"$repo_field\" = repo_key=pa-platform",
  "test \"$root_field\" = \"repo_root=$repo_root\"",
  "test \"$ticket_field\" = ticket=PAP-183",
  "test \"$branch_field\" = branch=feature/PAP-183-pi-plugin-options",
  "test \"$matrix_field\" = \"matrix_source=$matrix_source\"",
  "[[ \"$candidate_field\" =~ ^candidate_sha=([0-9a-f]{40})$ ]]",
  "expected_candidate=${BASH_REMATCH[1]}",
  "test \"$binding_line\" = \"$binding_version|$repo_field|$root_field|$ticket_field|$branch_field|$candidate_field|$matrix_field\"",
  "primer_digest=$(sha256sum -- \"$primer\")",
  "primer_digest=${primer_digest%% *}",
  "[[ \"$primer_digest\" =~ ^[0-9a-f]{64}$ ]]",
  "test \"$PA_REPO\" = \"$repo_root\"",
  "test \"$PA_TICKET_ID\" = PAP-183",
  "cd \"$repo_root\"",
  "test \"$PWD\" = \"$repo_root\"",
  "test \"$(git rev-parse --show-toplevel)\" = \"$repo_root\"",
  "test \"$(git branch --show-current)\" = feature/PAP-183-pi-plugin-options",
  "test \"$(git rev-parse HEAD)\" = \"$expected_candidate\"",
  "test -z \"$(git status --porcelain=v1 --untracked-files=all)\"",
  "git cat-file -e \"${base}^{commit}\"",
  "git cat-file -e \"${expected_candidate}^{commit}\"",
  "git merge-base --is-ancestor \"$base\" \"$expected_candidate\"",
  "mapfile -d '' -t changed_files < <(git diff --name-only -z \"$base..$expected_candidate\")",
  "candidate_file_count=${#changed_files[@]}",
  "test \"$candidate_file_count\" -gt 0",
  "if git submodule status --recursive | grep -Eq '^[+-U]'; then exit 1; fi",
  "test \"$(node --version)\" = v22.23.2",
  "test \"$(corepack pnpm --version)\" = 10.28.0",
  "test \"$(pi --version)\" = 0.84.4",
  "test \"$(nix eval --raw --impure --expr builtins.currentSystem)\" = x86_64-linux",
  "test -f \"$PWD/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/prebuilds/linux-x64.node\"",
  "printf 'preflight deployment=%s candidate=%s files=%s primer-sha256=%s status=0 system=x86_64-linux matrix=%s\\n' \"$PA_DEPLOYMENT_ID\" \"$expected_candidate\" \"$candidate_file_count\" \"$primer_digest\" \"$matrix_source\"",
  "PAP183_PREFLIGHT",
].join("\n");
const revisedGroup6Command = [
  "bash -euo pipefail <<'PAP183_SCAN'",
  "repo_root=/home/sinh/git-repos/sinh-x/tools/pa-platform",
  "base=00260cbd975cc9256a1bab685e4b035428b4d563",
  "matrix_source=agent-teams/requirements/artifacts/2026-09-11-pap-183-safety-compatible-validation-matrix-revision.md",
  ": \"${PA_DEPLOYMENT_DIR:?}\"",
  "primer=$PA_DEPLOYMENT_DIR/primer.md",
  "test -f \"$primer\"",
  "mapfile -t binding_lines < <(",
  "  awk '",
  "    BEGIN { terminator = \"<deployment-context\" sprintf(\"%c\", 62) }",
  "    $0 == \"## Additional Instructions\" && !seen { seen=1; inside=1; next }",
  "    inside && $0 == terminator { exit }",
  "    inside && index($0, \"PAP183_REVIEW_BINDING_V1|\") == 1 { print }",
  "  ' \"$primer\"",
  ")",
  "test \"${#binding_lines[@]}\" -eq 1",
  "binding_line=${binding_lines[0]}",
  "IFS='|' read -r binding_version repo_field root_field ticket_field branch_field candidate_field matrix_field extra <<<\"$binding_line\"",
  "test -z \"${extra:-}\"",
  "test \"$binding_version\" = PAP183_REVIEW_BINDING_V1",
  "test \"$repo_field\" = repo_key=pa-platform",
  "test \"$root_field\" = \"repo_root=$repo_root\"",
  "test \"$ticket_field\" = ticket=PAP-183",
  "test \"$branch_field\" = branch=feature/PAP-183-pi-plugin-options",
  "test \"$matrix_field\" = \"matrix_source=$matrix_source\"",
  "[[ \"$candidate_field\" =~ ^candidate_sha=([0-9a-f]{40})$ ]]",
  "expected_candidate=${BASH_REMATCH[1]}",
  "test \"$binding_line\" = \"$binding_version|$repo_field|$root_field|$ticket_field|$branch_field|$candidate_field|$matrix_field\"",
  "cd \"$repo_root\"",
  "test \"$(git rev-parse HEAD)\" = \"$expected_candidate\"",
  "mapfile -d '' -t changed_files < <(git diff --name-only -z \"$base..$expected_candidate\")",
  "candidate_file_count=${#changed_files[@]}",
  "test \"$candidate_file_count\" -gt 0",
  "scanner=scripts/hooks/pre-commit-secret-scan.sh",
  "test -f \"$scanner\"",
  "pattern=$(awk -F\"'\" '/grep -E -n/{print $2; exit}' \"$scanner\")",
  "test -n \"$pattern\"",
  "matches=$(git diff --unified=0 \"$base..$expected_candidate\" | grep -E '^\\+[^+]' | grep -E \"$pattern\" || true)",
  "test -z \"$matches\"",
  "printf 'candidate-addition-scan candidate=%s files=%s matches=0\\n' \"$expected_candidate\" \"$candidate_file_count\"",
  "PAP183_SCAN",
].join("\n");
const revisedGroup8Command = [
  "bash -euo pipefail <<'PAP183_FINAL'",
  "repo_root=/home/sinh/git-repos/sinh-x/tools/pa-platform",
  "base=00260cbd975cc9256a1bab685e4b035428b4d563",
  "matrix_source=agent-teams/requirements/artifacts/2026-09-11-pap-183-safety-compatible-validation-matrix-revision.md",
  ": \"${PA_DEPLOYMENT_ID:?}\" \"${PA_DEPLOYMENT_DIR:?}\" \"${PA_ACTIVITY_LOG:?}\" \"${PA_REPO:?}\" \"${PA_TICKET_ID:?}\"",
  "primer=$PA_DEPLOYMENT_DIR/primer.md",
  "test -f \"$primer\"",
  "mapfile -t binding_lines < <(",
  "  awk '",
  "    BEGIN { terminator = \"<deployment-context\" sprintf(\"%c\", 62) }",
  "    $0 == \"## Additional Instructions\" && !seen { seen=1; inside=1; next }",
  "    inside && $0 == terminator { exit }",
  "    inside && index($0, \"PAP183_REVIEW_BINDING_V1|\") == 1 { print }",
  "  ' \"$primer\"",
  ")",
  "test \"${#binding_lines[@]}\" -eq 1",
  "binding_line=${binding_lines[0]}",
  "IFS='|' read -r binding_version repo_field root_field ticket_field branch_field candidate_field matrix_field extra <<<\"$binding_line\"",
  "test -z \"${extra:-}\"",
  "test \"$binding_version\" = PAP183_REVIEW_BINDING_V1",
  "test \"$repo_field\" = repo_key=pa-platform",
  "test \"$root_field\" = \"repo_root=$repo_root\"",
  "test \"$ticket_field\" = ticket=PAP-183",
  "test \"$branch_field\" = branch=feature/PAP-183-pi-plugin-options",
  "test \"$matrix_field\" = \"matrix_source=$matrix_source\"",
  "[[ \"$candidate_field\" =~ ^candidate_sha=([0-9a-f]{40})$ ]]",
  "expected_candidate=${BASH_REMATCH[1]}",
  "test \"$binding_line\" = \"$binding_version|$repo_field|$root_field|$ticket_field|$branch_field|$candidate_field|$matrix_field\"",
  "primer_digest=$(sha256sum -- \"$primer\")",
  "primer_digest=${primer_digest%% *}",
  "[[ \"$primer_digest\" =~ ^[0-9a-f]{64}$ ]]",
  "test \"$PA_DEPLOYMENT_DIR\" = \"/home/sinh/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID\"",
  "test \"$PA_ACTIVITY_LOG\" = \"$PA_DEPLOYMENT_DIR/activity.jsonl\"",
  "test \"$PA_REPO\" = \"$repo_root\"",
  "test \"$PA_TICKET_ID\" = PAP-183",
  "cd \"$repo_root\"",
  "test \"$(git rev-parse --show-toplevel)\" = \"$repo_root\"",
  "git diff --check \"$base..$expected_candidate\"",
  "test \"$(git rev-parse HEAD)\" = \"$expected_candidate\"",
  "test \"$(git branch --show-current)\" = feature/PAP-183-pi-plugin-options",
  "test -z \"$(git status --porcelain=v1 --untracked-files=all)\"",
  "git merge-base --is-ancestor \"$base\" \"$expected_candidate\"",
  "mapfile -d '' -t changed_files < <(git diff --name-only -z \"$base..$expected_candidate\")",
  "candidate_file_count=${#changed_files[@]}",
  "test \"$candidate_file_count\" -gt 0",
  "printf 'final-integrity deployment=%s candidate=%s files=%s primer-sha256=%s status=0 matrix=%s\\n' \"$PA_DEPLOYMENT_ID\" \"$expected_candidate\" \"$candidate_file_count\" \"$primer_digest\" \"$matrix_source\"",
  "PAP183_FINAL",
].join("\n");

test("isDestructiveCommand allows descriptor duplication and closure", () => {
  const commands = [
    "printf ok 2>&1",
    "printf ok 1>&2",
    "exec >&-",
    "exec 2>&-",
  ];

  for (const command of commands) {
    assert.equal(isDestructiveCommand(command), false, command);
  }
});

test("isDestructiveCommand allows quoted markup and exact revised binding groups", () => {
  const commands = [
    `awk '$0 == "<deployment-context>" { exit }' primer.md`,
    `printf '%s\\n' '<section>'`,
    `bash -lc 'printf "%s\\n" "<section>"'`,
    revisedGroup1Command,
    revisedGroup6Command,
    revisedGroup8Command,
  ];

  for (const command of commands) {
    assert.equal(isDestructiveCommand(command), false, command);
  }
});

test("isDestructiveCommand allows the legacy group-7 descriptor-duplication pipeline", () => {
  assert.equal(isDestructiveCommand(legacyGroup7LoggingPipeline), false);
});

test("bootstrap-compatible group-7 command passes candidate and installed baseline classifiers", () => {
  assert.equal(isDestructiveCommand(bootstrapCompatibleGroup7Command), false);
  assert.equal(new RegExp(installedBaselineRedirectPattern, "i").test(bootstrapCompatibleGroup7Command), false);
});

test("isDestructiveCommand blocks pathname overwrite and truncation redirects", () => {
  const commands = [
    "printf ok 2>1",
    "printf ok 1>2",
    "exec >-",
    "printf ok > output.log",
    "printf ok >output.log",
    "printf ok 2> errors.log",
    "printf ok 2>errors.log",
    "printf ok >> output.log",
    "printf ok >>output.log",
    "printf ok 2>> errors.log",
    "printf ok 2>>errors.log",
    "printf ok >| output.log",
    "printf ok >|output.log",
    "printf ok >&output.log",
    `printf ok > "output.log"`,
    `printf ok 2>"errors.log"`,
    `bash -lc 'printf ok > "output.log"'`,
    `bash -lc 'printf "<section>" 2>"errors.log"'`,
    `bash -lc 'printf ok <input>output.log'`,
  ];

  for (const command of commands) {
    assert.equal(isDestructiveCommand(command), true, command);
  }
});

test("isDestructiveCommand keeps unrelated destructive command classes blocked", () => {
  const commands = [
    "rm output.log",
    "rmdir output",
    "unlink output.log",
    "shred output.log",
    "dd if=input of=output",
    "truncate -s 0 output.log",
    "find . -print0 | xargs -0 rm",
    "git clean -fd",
    "git push origin main --force",
  ];

  for (const command of commands) {
    assert.equal(isDestructiveCommand(command), true, command);
  }
});

test("context-aware policy denies path-qualified destructive executables and supported wrappers", () => {
  const directDeletion = [
    "/bin/rm /tmp/pap218-delete",
    "./rmdir /tmp/pap218-directory",
    "../bin/unlink /tmp/pap218-link",
    "/usr/bin/sudo /usr/bin/shred /tmp/pap218-secret",
    "command ./rm /tmp/pap218-command-delete",
    "/usr/bin/dd if=/tmp/source of=/tmp/destination",
    "./truncate -s 0 /tmp/pap218-truncated",
    "/usr/bin/find /tmp/pap218-tree -delete",
    "./find /tmp/pap218-tree -exec /bin/rm {} +",
    "/usr/bin/xargs /bin/rm",
    "/usr/bin/git clean -fd",
    "/bin/bash -lc './git clean -fd'",
  ];
  for (const command of directDeletion) assertDenied(command, "direct-deletion");

  for (const command of [
    "./git push origin main --force",
    "/usr/bin/sudo /usr/bin/git push origin main --force-with-lease",
    "/bin/bash -lc '/usr/bin/git push origin main --force'",
  ]) assertDenied(command, "destructive-command");
});

const protectedToken = ["cred", "entials"].join("");
const d3TicketJsonRedirect = [
  "ppa ticket list --project pa-platform --json > /tmp/pap-tickets.json && python3 - <<'PY'",
  "import json",
  "p='/tmp/pap-tickets.json'",
  "d=json.load(open(p))",
  "print(type(d).__name__, len(d) if isinstance(d,list) else d.keys())",
  "print(json.dumps((d[0] if isinstance(d,list) and d else d), indent=2)[:5000])",
  "PY",
].join("\n");
const d3PythonCounterPipeline = `ppa ticket list --project pa-platform --json | python3 -c 'import json,sys,collections; d=json.load(sys.stdin); c=collections.Counter(x["id"] for x in d); print("rows",len(d),"unique",len(c),"dupes",sum(v-1 for v in c.values())); print("counts",collections.Counter(x["status"] for x in d)); print("unique statuses",collections.Counter({k:0 for k in []})); print("dup ids",[(k,v) for k,v in c.items() if v>1][:30])'`;
const d3GitAncestryLoop = [
  "for item in PAP-127:036bb8d15f2b5383ad546be915259b04caa9f504 PAP-129:232c41b87aea8275131e601a9e804e052e943318 PAP-142:unknown PAP-144:e480cd43bd53fe48cfa54951982dd1a64e3e18cd PAP-145:ed798449ed2fcd06c570ce4fd38e6803f6713579 PAP-149:5de7c8bbf22dbf825fcf5184e7a21285e179becf PAP-151:b14bdc40727a7e7ce0b62aa47265fd2cd581c5c8 PAP-216:2c5b8cd0d4c6b41634193ba4eaf0916394ed5c6f; do id=${item%%:*}; sha=${item#*:}; if git cat-file -e \"$sha^{commit}\" 2>/dev/null; then if git merge-base --is-ancestor \"$sha\" develop; then merged=yes; else merged=no; fi; printf '%s %s %s ' \"$id\" \"$sha\" \"$merged\"; git log -1 --format='%ad %s' --date=short \"$sha\"; else echo \"$id $sha absent\"; fi; done",
  "printf '\\nMerge commits by ticket:\\n'",
  "git log develop --oneline --merges --grep='PAP-127\\|PAP-129\\|PAP-142\\|PAP-144\\|PAP-145\\|PAP-149\\|PAP-151\\|PAP-216'",
].join("\n");
const confirmedHealthCheck = `curl -sS --max-time 15 -o /tmp/andafit-current-health.json -w '%{http_code}\\n' https://internal.andafin.net/andafit-movement/health; status=$?; printf 'curl_status=%s\\n' "$status"; if [ -s /tmp/andafit-current-health.json ]; then jq -c . /tmp/andafit-current-health.json 2>/dev/null || head -c 500 /tmp/andafit-current-health.json; fi`;

function assertDenied(command: string, code: string): void {
  const decision = classifyShellCommand(command);
  assert.equal(decision.allowed, false, command);
  assert.equal(decision.code, code, command);
  assert.ok(decision.reason, command);
}

test("context declarations keep ordinary prose separate from path operands", () => {
  const prose = `No additional ${protectedToken} or network service are required.`;
  for (const kind of ["question", "todo", "shell-script description"]) {
    const decision = evaluateSafetyPolicy({ kind: "prose", value: `${kind}: ${prose}` });
    assert.equal(decision.allowed, true, kind);
  }

  const protectedPath = `/work/${protectedToken}.json`;
  assert.equal(isBlockedFilePath(protectedPath), true);
  assert.equal(classifyPathOperand(protectedPath).code, "protected-path");
  assert.equal(evaluateSafetyPolicy({ kind: "path", value: protectedPath }).allowed, false);

  const proseScript = [
    "python3 - <<'PY'",
    `message = ${JSON.stringify(prose)}`,
    "print(message)",
    "PY",
  ].join("\n");
  assert.equal(classifyShellCommand(proseScript).allowed, true);
});

test("context-aware shell classification admits null-sink and verified temp output", (t) => {
  const customTmp = mkdtempSync(join(process.cwd(), ".pap218-tmp-"));
  t.after(() => rmSync(customTmp, { recursive: true, force: true }));
  const env = { TMPDIR: customTmp };
  const commands = [
    "printf ok > /dev/null",
    "printf ok 2>/dev/null",
    "printf ok >/tmp/pap218-output.json",
    `printf ok > "${join(customTmp, "quoted output.json")}"`,
    "printf ok > \"$TMPDIR/from-variable.json\"",
    confirmedHealthCheck,
  ];

  for (const command of commands) {
    const decision = classifyShellCommand(command, { env });
    assert.equal(decision.allowed, true, `${command}: ${decision.reason ?? "allowed"}`);
    assert.equal(decision.effect, "write", command);
  }
});

test("exact d-3c317b inspection workflows are allowed", () => {
  for (const command of [d3TicketJsonRedirect, d3PythonCounterPipeline, d3GitAncestryLoop]) {
    const decision = classifyShellCommand(command);
    assert.equal(decision.allowed, true, `${decision.code}: ${decision.reason ?? command}`);
  }
});

test("protected, arbitrary, traversal, and ambiguous output remains denied with reasons", () => {
  const protectedPath = `/tmp/${protectedToken}.json`;
  assertDenied(`cat /home/user/${[".s", "sh"].join("")}/${["id", "_rsa"].join("")}`, "protected-path");
  assertDenied(`printf ok > ${protectedPath}`, "protected-path");
  assertDenied("printf ok > /var/log/pap218-output.log", "arbitrary-output");
  assertDenied("curl -sS -o /var/log/pap218-output.json https://example.test/health", "arbitrary-output");
  assertDenied("printf ok > output.log", "arbitrary-output");
  assertDenied("printf ok > /tmp/../etc/pap218-output.log", "path-traversal");
  assertDenied("printf ok > \"$OUTPUT_FILE\"", "ambiguous-output");
  assertDenied("printf ok > \"$(mktemp)\"", "ambiguous-output");
  assertDenied("printf ok > ", "ambiguous-output");

  assert.equal(classifyOutputTarget("$TMPDIR/file", { env: {} }).code, "ambiguous-output");
  assert.equal(classifyOutputTarget("$TMPDIR/file", { env: { TMPDIR: "relative/tmp" } }).code, "ambiguous-output");
  assert.equal(classifyOutputTarget("$TMPDIR/file", { env: { TMPDIR: "/does-not-exist-pap218" } }).allowed, false);
});

test("verified temp output rejects symlink escape while allowing an in-root symlink", (t) => {
  const root = mkdtempSync("/tmp/pap218-boundary-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const safeDirectory = join(root, "safe");
  mkdirSync(safeDirectory);
  symlinkSync(safeDirectory, join(root, "safe-link"));
  symlinkSync("/etc", join(root, "escape-link"));

  const safe = classifyShellCommand(`printf ok > ${join(root, "safe-link", "result.json")}`);
  assert.equal(safe.allowed, true, safe.reason);

  const escaped = classifyShellCommand(`printf ok > ${join(root, "escape-link", "result.json")}`);
  assert.equal(escaped.allowed, false);
  assert.equal(escaped.code, "symlink-escape");
  assert.ok(escaped.reason);
});

test("nested shell output is bounded and descriptor compatibility is retained", () => {
  assert.equal(classifyShellCommand(`bash -lc 'printf ok > /tmp/nested-output.log'`).allowed, true);
  assertDenied(`bash -lc 'printf ok > output.log'`, "arbitrary-output");
  for (const command of ["printf ok 2>&1", "printf ok 1>&2", "exec >&-", "exec 2>&-"]) {
    assert.equal(classifyShellCommand(command).allowed, true, command);
  }
  for (const command of ["printf ok 2>1", "printf ok 1>2", "exec >-"]) {
    assertDenied(command, "arbitrary-output");
  }
});

test("direct deletion stays denied with active-adapter trash guidance", () => {
  const direct = classifyShellCommand("rm output.log", { trashExecutable: "ppa" });
  assert.equal(direct.allowed, false);
  assert.equal(direct.code, "direct-deletion");
  assert.equal(direct.target, "output.log");
  assert.match(direct.guidance ?? "", /^ppa trash move 'output\.log' /);
  assert.match(direct.guidance ?? "", /--reason '[^']+' --yes$/);

  const cleanup = classifyShellCommand([
    "status_file=$(mktemp)",
    "trap 'rm -f \"$status_file\"' EXIT",
    "git status --porcelain=v2 -z >\"$status_file\"",
  ].join("\n"), { trashExecutable: "opa" });
  assert.equal(cleanup.allowed, false);
  assert.equal(cleanup.code, "direct-deletion");
  assert.equal(cleanup.target, '"$status_file"');
  assert.equal(cleanup.guidance, `opa trash move "$status_file" --reason 'Replace direct deletion denied by PA safety policy' --yes`);

  assert.equal(formatTrashMoveGuidance("/tmp/file", "dpa"), `dpa trash move '/tmp/file' --reason 'Replace direct deletion denied by PA safety policy' --yes`);
});

test("context-aware policy p95 stays below 5 ms after warm-up", (t) => {
  const fixtures = [
    () => classifyShellCommand(confirmedHealthCheck),
    () => classifyShellCommand(d3PythonCounterPipeline),
    () => evaluateSafetyPolicy({ kind: "prose", value: `ordinary ${protectedToken} prose` }),
    () => classifyShellCommand("rm /tmp/pap218-delete-me", { trashExecutable: "ppa" }),
  ];
  for (let index = 0; index < 250; index += 1) fixtures[index % fixtures.length]?.();

  const measuredCalls = 1_200;
  const samples: number[] = [];
  for (let index = 0; index < measuredCalls; index += 1) {
    const start = process.cpuUsage();
    fixtures[index % fixtures.length]?.();
    const elapsed = process.cpuUsage(start);
    samples.push((elapsed.user + elapsed.system) / 1_000);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  t.diagnostic(`policy benchmark measured_calls=${measuredCalls} p95_ms=${p95.toFixed(3)} clock=process_cpu`);
  assert.ok(measuredCalls >= 1_000);
  assert.ok(p95 < 5, `expected p95 < 5 ms, measured ${p95.toFixed(3)} ms over ${measuredCalls} calls`);
});
