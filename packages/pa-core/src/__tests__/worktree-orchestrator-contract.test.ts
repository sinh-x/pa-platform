import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const configRoot = process.env["PA_PHASE5_CONFIG_ROOT"];
const modePath = configRoot ? join(configRoot, "teams", "builder", "modes", "orchestrator.md") : "";
const implementPath = configRoot ? join(configRoot, "teams", "builder", "modes", "implement.md") : "";
const routinePath = configRoot ? join(configRoot, "teams", "builder", "modes", "routine.md") : "";
const objectivePath = configRoot ? join(configRoot, "skills", "templates", "builder-objective.md") : "";
const reportPath = configRoot ? join(configRoot, "skills", "templates", "orchestration-report.md") : "";

test("builder orchestrator contract creates isolated deterministic worktrees", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const mode = readFileSync(modePath, "utf-8").replace(/\s+/g, " ");

  assert.match(mode, /worktree_path = \/tmp\/pa-worktrees\/<repo-key>\/<ticket-id>\/<orchestrator-deployment-id>/);
  assert.match(mode, /execution_path = worktree_path when strategy=worktree, otherwise canonical_repo/);
  assert.match(mode, /Persist execution_path in the orchestration report and reuse this exact value/);
  assert.match(mode, /git -C <canonical_repo> worktree add -b <feature_branch>/);
  assert.match(mode, /without changing the canonical\s+checkout/);
  assert.match(mode, /Canonical strategy gate:.*exclusive lock/);
  assert.match(mode, /Collision rejection must not create/);
  assert.match(mode, /canonical-checkout mutation/);
  assert.match(mode, /Reject a live orchestrator for the same ticket/);
});

test("builder orchestrator contract validates resume evidence before recreation", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const mode = readFileSync(modePath, "utf-8").replace(/\s+/g, " ");

  assert.match(mode, /If the worktree exists, verify its git common-dir and branch/);
  assert.match(mode, /recreate the exact recorded path only when the ownership evidence matches/);
  assert.match(mode, /Missing, stale, ambiguous, or branch-mismatched evidence stops for operator review/);
  assert.match(mode, /same normalized repository plus branch or worktree path/);
});

test("builder objective and report retain complete worktree ownership evidence", (t) => {
  if (!existsSync(objectivePath) || !existsSync(reportPath)) return t.skip("external pa-platform-config fixture not available");
  const objective = readFileSync(objectivePath, "utf-8");
  const report = readFileSync(reportPath, "utf-8");
  const fields = ["Canonical Repository", "Normalized Remote", "Worktree", "Branch", "Owner Deployment", "Lifecycle Status", "Cleanup Result"];

  for (const field of fields) {
    assert.match(objective, new RegExp(field));
    assert.match(report, new RegExp(field));
  }
  assert.match(report, /Ticket: <ticket_id>/);
  assert.match(report, /Canonical checkout before\/after/);
  assert.match(report, /Collision checks/);
});

test("all implementation child launches pass the recorded worktree", (t) => {
  if (!existsSync(modePath)) return t.skip("external pa-platform-config fixture not available");
  const mode = readFileSync(modePath, "utf-8");
  const normalized = mode.replace(/\s+/g, " ");
  const launches = normalized.match(/opa deploy (?:builder --mode implement|requirements --mode review-auto) .*?(?= opa status| Locate the review report)/g) ?? [];
  assert.ok(launches.length >= 3, "expected implementation, review, and fix launch contracts");
  for (const launch of launches) assert.match(launch, /--repo "<execution_path>"/);
  assert.match(mode, /Review the changes[\s\S]*?Repo: <execution_path>[\s\S]*?Canonical Repository: <canonical_repo_path>[\s\S]*?Worktree: <execution_path>[\s\S]*?Branch: <feature_branch>/);
  assert.match(mode, /- `Context`: include `Repo: <execution_path>[\s\S]*?Canonical Repository:[\s\S]*?Worktree: <execution_path>[\s\S]*?Branch: <feature_branch>/);
  assert.match(mode, /If the fix child fails transiently and is retried[\s\S]*?same objective file contents[\s\S]*?canonical path/);
});

test("canonical and worktree execution rules are strategy-aware", (t) => {
  if (!existsSync(modePath) || !existsSync(implementPath)) return t.skip("external pa-platform-config fixture not available");
  const orchestrator = readFileSync(modePath, "utf-8");
  const implement = readFileSync(implementPath, "utf-8");

  assert.match(implement, /In `worktree` mode, never read or write project files through the canonical checkout/);
  assert.match(implement, /In `canonical` mode, the lock-protected canonical feature checkout is the recorded execution path and is permitted/);
  assert.doesNotMatch(implement, /Never work directly on the canonical repository/);
  assert.match(orchestrator, /Push from the recorded execution path selected by the strategy/);
  assert.match(orchestrator, /lock-protected canonical feature checkout in\s+# canonical mode/);
  assert.match(orchestrator, /cd <execution_path>\s+git push -u origin <feature-branch>/);
});

test("routine merge contract validates reports and merged PR ancestry before closure", (t) => {
  if (!existsSync(routinePath)) return t.skip("external pa-platform-config fixture not available");
  const routine = readFileSync(routinePath, "utf-8");

  assert.match(routine, /--json number,state,headRefName,baseRefName,/);
  assert.match(routine, /merge_evidence=\$\(routine_github_merge_evidence <TICKET-ID> <number> \{\{GH_REPO\}\} "\$target_branch" unverified\) \|\| continue/);
  assert.match(routine, /merge_evidence=\$\(routine_local_merge_evidence <TICKET-ID> <linked-branch> "\$target_branch"\) \|\| continue/);
  assert.match(routine, /routine_github_merge_evidence\(\)[\s\S]*?merge-base --is-ancestor "\$merge_commit" "origin\/\$target_branch"/);
  assert.match(routine, /routine_local_merge_evidence\(\)[\s\S]*?\[ "\$remote_target" != "\$merge_commit" \]/);
  assert.match(routine, /canonical checkout must be fully clean before mutation/);
  assert.match(routine, /push failed; restored verified clean target to \$before_merge_target/);
});

test("routine exact merge and cleanup helpers fail closed around durable evidence", (t) => {
  if (!existsSync(routinePath)) return t.skip("external pa-platform-config fixture not available");
  const routine = readFileSync(routinePath, "utf-8");
  const helpers = routine.match(/# BEGIN ROUTINE MERGE HELPERS\n([\s\S]*?)\n# END ROUTINE MERGE HELPERS/)?.[1];
  const cleanupHelper = routine.match(/\n(cleanup_worktree_if_eligible\(\) \{[\s\S]*?\n\})\n```/)?.[1];
  assert.ok(helpers, "routine merge helpers must be delimited executable shell");
  assert.ok(cleanupHelper, "routine cleanup helper must be executable shell");

  const root = mkdtempSync(join(tmpdir(), "pa-routine-evidence-"));
  const home = join(root, "home");
  const artifacts = join(home, "Documents", "ai-usage", "agent-teams", "builder", "artifacts");
  const bin = join(root, "bin");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(bin);
  const opa = join(bin, "opa");
  writeFileSync(opa, "#!/usr/bin/env bash\nprintf '{\"status\":\"%s\",\"doc_refs\":[{\"type\":\"orchestration\",\"primary\":true,\"path\":\"%s\"}]}\\n' \"${OPA_STATUS:-review-uat}\" \"$OPA_REPORT\"\n");
  chmodSync(opa, 0o755);
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/usr/bin/env bash\nprintf '%s\\n' \"${OPA_MERGE_SHA:-}\"\n");
  chmodSync(gh, 0o755);

  const fixture = `set -euo pipefail
${helpers}
${cleanupHelper}

git_config=( -c user.name=Test -c user.email=test@example.com )
make_repo() {
  local name="$1" merge_first="$2" reject_push="$3" target="\${4:-develop}" stale="\${5:-false}" repo remote base_sha
  repo="$OPA_ROOT/$name"
  remote="$OPA_ROOT/$name.git"
  mkdir -p "$repo"
  git init -b "$target" "$repo" >/dev/null
  git -C "$repo" config user.name Test
  git -C "$repo" config user.email test@example.com
  printf 'base\\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" "\${git_config[@]}" commit -m base >/dev/null
  base_sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout -b feature/PAP-135 >/dev/null
  printf '%s\\n' "$name" > "$repo/feature.txt"
  git -C "$repo" add feature.txt
  git -C "$repo" "\${git_config[@]}" commit -m feature >/dev/null
  git -C "$repo" checkout "$target" >/dev/null
  git init --bare "$remote" >/dev/null
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -u origin "$target" feature/PAP-135 >/dev/null
  if [ "$merge_first" = true ]; then
    git -C "$repo" "\${git_config[@]}" merge --no-ff feature/PAP-135 -m merged >/dev/null
    git -C "$repo" push origin "$target" >/dev/null
    if [ "$stale" = true ]; then git -C "$repo" reset --hard "$base_sha" >/dev/null; fi
  fi
  if [ "$reject_push" = true ]; then
    printf '#!/usr/bin/env bash\\nexit 1\\n' > "$remote/hooks/pre-receive"
    chmod +x "$remote/hooks/pre-receive"
  fi
}

write_report() {
  local path="$1" repo="$2" branch="\${3:-feature/PAP-135}" remote="\${4:-}"
  [ -n "$remote" ] || remote=$(git -C "$repo" remote get-url origin)
  printf 'Canonical Repository: %s\\nNormalized Remote: %s\\nBranch: %s\\nMerge Evidence: pending\\n' "$repo" "$remote" "$branch" > "$path"
}

make_repo github true false
make_repo local-fresh false false
make_repo local-merged true false
make_repo local-reject false true
make_repo local-stale true false develop true
make_repo local-ambiguous false false
make_repo local-monthly-fresh false false monthly/2026-04
make_repo local-monthly-merged true false monthly/2026-04
make_repo dirty-staged false false
make_repo dirty-unstaged false false
make_repo dirty-untracked false false
make_repo ownership-branch false false
make_repo ownership-remote false false
write_report "$OPA_ARTIFACTS/github.md" "$OPA_ROOT/github"
write_report "$OPA_ARTIFACTS/local-fresh.md" "$OPA_ROOT/local-fresh"
write_report "$OPA_ARTIFACTS/local-merged.md" "$OPA_ROOT/local-merged"
write_report "$OPA_ARTIFACTS/local-reject.md" "$OPA_ROOT/local-reject"
write_report "$OPA_ARTIFACTS/local-stale.md" "$OPA_ROOT/local-stale"
write_report "$OPA_ARTIFACTS/local-ambiguous.md" "$OPA_ROOT/local-ambiguous"
write_report "$OPA_ARTIFACTS/local-monthly-fresh.md" "$OPA_ROOT/local-monthly-fresh"
write_report "$OPA_ARTIFACTS/local-monthly-merged.md" "$OPA_ROOT/local-monthly-merged"
write_report "$OPA_ARTIFACTS/dirty-staged.md" "$OPA_ROOT/dirty-staged"
write_report "$OPA_ARTIFACTS/dirty-unstaged.md" "$OPA_ROOT/dirty-unstaged"
write_report "$OPA_ARTIFACTS/dirty-untracked.md" "$OPA_ROOT/dirty-untracked"
write_report "$OPA_ARTIFACTS/ownership-branch.md" "$OPA_ROOT/ownership-branch" feature/PAP-other
write_report "$OPA_ARTIFACTS/ownership-remote.md" "$OPA_ROOT/ownership-remote" feature/PAP-135 ssh://git@wrong.example/owner/repo.git
printf 'Canonical Repository: %s\\nNormalized Remote: %s\\nBranch: feature/PAP-135\\n' "$OPA_ROOT/github" "$OPA_ROOT/github.git" > "$OPA_ARTIFACTS/persist-fail.md"

# The exact GitHub helper generates durable evidence before allowing closure.
OPA_REPORT="$OPA_ARTIFACTS/github.md"
OPA_MERGE_SHA=$(git -C "$OPA_ROOT/github" rev-parse develop)
export OPA_REPORT OPA_MERGE_SHA
ticket_status=open
if merge_evidence=$(routine_github_merge_evidence PAP-135 13 fixture/repo develop unverified); then ticket_status=done; fi
[ "$ticket_status" = done ]
[ "$(awk -F': ' '/^Merge Evidence: / {print $2}' "$OPA_REPORT")" = "$merge_evidence" ]

# Missing, malformed, non-ancestor, and persistence-failure inputs stay open.
for bad_sha in missing malformed nonancestor persistence; do
  OPA_REPORT="$OPA_ARTIFACTS/github.md"
  case "$bad_sha" in
    missing) OPA_MERGE_SHA= ;;
    malformed) OPA_MERGE_SHA=not-a-sha ;;
    nonancestor) OPA_MERGE_SHA=0000000000000000000000000000000000000000 ;;
    persistence) OPA_MERGE_SHA=$(git -C "$OPA_ROOT/github" rev-parse develop); OPA_REPORT="$OPA_ARTIFACTS/persist-fail.md" ;;
  esac
  export OPA_REPORT OPA_MERGE_SHA
  ticket_status=open
  if routine_github_merge_evidence PAP-135 13 fixture/repo develop unverified >/dev/null; then ticket_status=done; fi
  [ "$ticket_status" = open ]
done

# Fresh and already-merged local paths execute the same helper and close only
# after generated evidence is durable.
for kind in local-fresh local-merged local-stale; do
  OPA_REPORT="$OPA_ARTIFACTS/$kind.md"; export OPA_REPORT
  ticket_status=open
  if merge_evidence=$(routine_local_merge_evidence PAP-135 feature/PAP-135 develop); then ticket_status=done; fi
  [ "$ticket_status" = done ]
  [ "$(awk -F': ' '/^Merge Evidence: / {print $2}' "$OPA_REPORT")" = "$merge_evidence" ]
  local_sha=$(git -C "$OPA_ROOT/$kind" rev-parse develop)
  remote_sha=$(git -C "$OPA_ROOT/$kind" ls-remote origin refs/heads/develop | awk '{print $1}')
  [ "$local_sha" = "$remote_sha" ]
done

# Slash-containing configured targets persist and validate on fresh and
# already-merged paths without ambiguous delimiter parsing.
for kind in local-monthly-fresh local-monthly-merged; do
  OPA_REPORT="$OPA_ARTIFACTS/$kind.md"; export OPA_REPORT
  merge_evidence=$(routine_local_merge_evidence PAP-135 feature/PAP-135 monthly/2026-04)
  target_hex=$(printf '%s\\n' "$merge_evidence" | sed -n 's/^local:target_hex=\\([0-9a-f]*\\);.*/\\1/p')
  [ "$(decode_ref_hex "$target_hex")" = monthly/2026-04 ]
  [ "$(awk -F': ' '/^Merge Evidence: / {print $2}' "$OPA_REPORT")" = "$merge_evidence" ]
done

# Recorded ownership mismatches reject before Git refs, reports, or checkout mutate.
for kind in ownership-branch ownership-remote; do
  OPA_REPORT="$OPA_ARTIFACTS/$kind.md"; export OPA_REPORT
  before=$(git -C "$OPA_ROOT/$kind" for-each-ref --format='%(refname) %(objectname)'; git hash-object "$OPA_REPORT"; git -C "$OPA_ROOT/$kind" symbolic-ref --short HEAD)
  ! routine_local_merge_evidence PAP-135 feature/PAP-135 develop >/dev/null
  after=$(git -C "$OPA_ROOT/$kind" for-each-ref --format='%(refname) %(objectname)'; git hash-object "$OPA_REPORT"; git -C "$OPA_ROOT/$kind" symbolic-ref --short HEAD)
  [ "$after" = "$before" ]
done

# Staged, unstaged, and untracked canonical changes reject byte-for-byte before mutation.
printf 'dirty staged\\n' >> "$OPA_ROOT/dirty-staged/README.md"
git -C "$OPA_ROOT/dirty-staged" add README.md
printf 'dirty unstaged\\n' >> "$OPA_ROOT/dirty-unstaged/README.md"
printf 'dirty untracked\\n' > "$OPA_ROOT/dirty-untracked/untracked.txt"
for kind in dirty-staged dirty-unstaged dirty-untracked; do
  OPA_REPORT="$OPA_ARTIFACTS/$kind.md"; export OPA_REPORT
  before=$(git -C "$OPA_ROOT/$kind" status --porcelain=v1; git -C "$OPA_ROOT/$kind" hash-object README.md; [ ! -e "$OPA_ROOT/$kind/untracked.txt" ] || git -C "$OPA_ROOT/$kind" hash-object untracked.txt; git -C "$OPA_ROOT/$kind" symbolic-ref --short HEAD)
  ! routine_local_merge_evidence PAP-135 feature/PAP-135 develop >/dev/null
  after=$(git -C "$OPA_ROOT/$kind" status --porcelain=v1; git -C "$OPA_ROOT/$kind" hash-object README.md; [ ! -e "$OPA_ROOT/$kind/untracked.txt" ] || git -C "$OPA_ROOT/$kind" hash-object untracked.txt; git -C "$OPA_ROOT/$kind" symbolic-ref --short HEAD)
  [ "$after" = "$before" ]
done

# A transport that updates the remote and then reports failure converges by
# re-fetching the successful remote state instead of restoring or re-pushing.
REAL_GIT=$(command -v git); export REAL_GIT
cat > "$OPA_BIN/git" <<'EOF'
#!/usr/bin/env bash
if [ "\${OPA_AMBIGUOUS_REPO:-}" ] && [ "$1" = -C ] && [ "$2" = "$OPA_AMBIGUOUS_REPO" ] && [ "$3" = push ]; then
  "$REAL_GIT" "$@"
  exit 1
fi
exec "$REAL_GIT" "$@"
EOF
chmod +x "$OPA_BIN/git"
OPA_AMBIGUOUS_REPO="$OPA_ROOT/local-ambiguous"; OPA_REPORT="$OPA_ARTIFACTS/local-ambiguous.md"
export OPA_AMBIGUOUS_REPO OPA_REPORT
merge_evidence=$(routine_local_merge_evidence PAP-135 feature/PAP-135 develop)
[ "$(git -C "$OPA_ROOT/local-ambiguous" rev-parse develop)" = "$(git -C "$OPA_ROOT/local-ambiguous" ls-remote origin refs/heads/develop | awk '{print $1}')" ]
[ "$(awk -F': ' '/^Merge Evidence: / {print $2}' "$OPA_REPORT")" = "$merge_evidence" ]
unset OPA_AMBIGUOUS_REPO

# A failed push restores the before-state; retry cannot see an unpushed merge as complete.
OPA_REPORT="$OPA_ARTIFACTS/local-reject.md"; export OPA_REPORT
git -C "$OPA_ROOT/local-reject" checkout feature/PAP-135 >/dev/null
before_sha=$(git -C "$OPA_ROOT/local-reject" rev-parse develop)
before_branch=$(git -C "$OPA_ROOT/local-reject" symbolic-ref --short HEAD)
for attempt in 1 2; do
  ticket_status=open
  if routine_local_merge_evidence PAP-135 feature/PAP-135 develop >/dev/null; then ticket_status=done; fi
  [ "$ticket_status" = open ]
  [ "$(git -C "$OPA_ROOT/local-reject" rev-parse develop)" = "$before_sha" ]
  [ "$(git -C "$OPA_ROOT/local-reject" symbolic-ref --short HEAD)" = "$before_branch" ]
  ! git -C "$OPA_ROOT/local-reject" merge-base --is-ancestor feature/PAP-135 develop
  [ "$(awk -F': ' '/^Merge Evidence: / {print $2}' "$OPA_REPORT")" = pending ]
done

# Cleanup decodes a slash-containing target and accepts otherwise valid evidence.
cleanup_repo="$OPA_ROOT/local-monthly-merged"
cleanup_worktree="$OPA_CLEANUP_WORKTREE"
mkdir -p "$(dirname "$cleanup_worktree")"
git -C "$cleanup_repo" worktree add "$cleanup_worktree" feature/PAP-135 >/dev/null
cleanup_sha=$(git -C "$cleanup_repo" rev-parse monthly/2026-04)
cleanup_remote=$(git -C "$cleanup_repo" remote get-url origin)
cleanup_evidence="local:target_hex=$(encode_ref_hex monthly/2026-04);merge_commit=$cleanup_sha;ancestor=true;remote=$cleanup_sha;verified=true"
OPA_REPORT="$OPA_ARTIFACTS/cleanup-monthly.md"; OPA_STATUS=done; export OPA_REPORT OPA_STATUS
cat > "$OPA_REPORT" <<EOF
Canonical Repository: $cleanup_repo
Normalized Remote: $cleanup_remote
Worktree: $cleanup_worktree
Branch: feature/PAP-135
Ticket: PAP-135
Owner Deployment: d-fixture
Execution strategy: worktree
Merge Evidence: $cleanup_evidence
- Canonical repository: $cleanup_repo
- Worktree path: $cleanup_worktree
- Feature branch: feature/PAP-135
- Owner deployment: d-fixture
Lifecycle Status: created
Cleanup Result: pending
EOF
DRY_RUN=false
DECISION_LOG="$OPA_ROOT/decision.log"
cleanup_worktree_if_eligible PAP-135 "$cleanup_evidence" "ancestor=true;remote=$cleanup_sha;verified=true"
[ ! -e "$cleanup_worktree" ]
grep -q '^Cleanup Result: removed$' "$OPA_REPORT"

# Cleanup must reject remotes whose case-distinct repository paths identify
# different generic/self-hosted repositories.
cleanup_repo="$OPA_ROOT/local-merged"
git -C "$cleanup_repo" remote set-url origin ssh://git@Git.Example/Org/Repo.git
cleanup_worktree="$OPA_CLEANUP_WORKTREE"
mkdir -p "$(dirname "$cleanup_worktree")"
git -C "$cleanup_repo" worktree add "$cleanup_worktree" feature/PAP-135 >/dev/null
cleanup_sha=$(git -C "$cleanup_repo" rev-parse develop)
OPA_REPORT="$OPA_ARTIFACTS/cleanup.md"; OPA_STATUS=done; export OPA_REPORT OPA_STATUS
cat > "$OPA_REPORT" <<EOF
Canonical Repository: $cleanup_repo
Normalized Remote: git.example/Org/repo.git
Worktree: $cleanup_worktree
Branch: feature/PAP-135
Ticket: PAP-135
Owner Deployment: d-fixture
Execution strategy: worktree
Merge Evidence: local:target_hex=$(encode_ref_hex develop);merge_commit=$cleanup_sha;ancestor=true;remote=$cleanup_sha;verified=true
- Canonical repository: $cleanup_repo
- Worktree path: $cleanup_worktree
- Feature branch: feature/PAP-135
- Owner deployment: d-fixture
Lifecycle Status: created
Cleanup Result: pending
EOF
report_before=$(git hash-object "$OPA_REPORT")
canonical_before=$(git -C "$cleanup_repo" status --porcelain=v1; git -C "$cleanup_repo" rev-parse HEAD)
DRY_RUN=false
DECISION_LOG="$OPA_ROOT/decision.log"
cleanup_worktree_if_eligible PAP-135 "local:target_hex=$(encode_ref_hex develop);merge_commit=$cleanup_sha;ancestor=true;remote=$cleanup_sha;verified=true" "ancestor=true;remote=$cleanup_sha;verified=true"
[ -d "$cleanup_worktree" ]
[ "$(git hash-object "$OPA_REPORT")" = "$report_before" ]
[ "$(git -C "$cleanup_repo" status --porcelain=v1; git -C "$cleanup_repo" rev-parse HEAD)" = "$canonical_before" ]
grep -q 'rejected:ownership-or-done-validation-failed' "$DECISION_LOG"
`;

  const cleanupWorktree = join("/tmp", "pa-worktrees", "case-remote", "PAP-135", root.slice(root.lastIndexOf("/") + 1));
  try {
    execFileSync("bash", ["-c", fixture], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        OPA_ROOT: root,
        OPA_ARTIFACTS: artifacts,
        OPA_BIN: bin,
        OPA_CLEANUP_WORKTREE: cleanupWorktree,
      },
      stdio: "pipe",
    });
  } finally {
    rmSync(cleanupWorktree, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
