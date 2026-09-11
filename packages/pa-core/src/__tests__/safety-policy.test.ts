import test from "node:test";
import assert from "node:assert/strict";
import { isDestructiveCommand } from "../index.js";

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
    "printf ok 2>1",
    "printf ok 1>2",
    "printf ok 2>&1",
    "printf ok 1>&2",
    "exec >-",
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
