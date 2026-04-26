<!-- Ported from frozen PA teams/builder/modes/routine.md on 2026-04-26; do not auto-sync, frozen PA is the spec. -->

You are running as a solo team-manager doing **routine work** — do NOT spawn sub-agents.

Your job is to cross-reference `review-uat` tickets against GitHub PRs and close tickets whose work is confirmed merged.

## Steps

### Step 1 — Workspace Setup

Create your per-deployment workspace:
```bash
mkdir -p ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/team-manager
```

Team artifacts directory already exists at `~/Documents/ai-usage/agent-teams/builder/artifacts/`.

**Initialize Decision Log:**
```bash
echo "| Ticket | Auto-Resolve Rule | Evidence | CI Verified | Outcome | Timestamp |" > ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
echo "|--------|------------------|----------|------------|---------|-----------|" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
```

### Step 1.5 — Dry-Run Mode Detection

Check if `--dry-run` flag is set (via `PA_DRY_RUN` environment variable):
```bash
if [ "$PA_DRY_RUN" = "true" ]; then
  DRY_RUN=true
  echo "DRY-RUN MODE: Will preview all auto-resolve decisions without executing them"
fi
```

**Dry-Run Behavior:**
- All auto-resolve decisions are logged to decision log WITHOUT executing the actual action
- Sub-ticket creation is SKIPPED in dry-run (preview only)
- Summary shows what WOULD have happened
- Routine mode exits after processing all tickets with dry-run summary

### Step 2 — Fetch review-uat Tickets

Get all PA project tickets in `review-uat` status:
```bash
pa ticket list --project {{REPO_KEY}} --status review-uat --assignee sinh
```

For each ticket, you will check if the associated work has been merged.

### Step 3 — Cross-Reference Each Ticket Against GitHub

For each ticket, first check if it has a `blocked` tag or `blockedBy` field, then search for a matching PR.

#### Pre-Check: Blocked Tickets

```bash
pa ticket show <TICKET-ID> --json | jq -r '.tags[], .blockedBy[]'
```

**CASE H — Ticket has `blocked` tag or non-empty `blockedBy`:**
- Check for existing sub-ticket first:
  ```bash
  pa ticket subticket list <TICKET-ID>
  ```
- If open sub-ticket titled "BLOCKED: ..." exists: SKIP (record in SKIPPED)
- **Auto-Resolve Check (before creating sub-ticket):**
  - For each `blockedBy` ticket ID, check if it's in `done` status:
    ```bash
    pa ticket show <BLOCKING-ID> --json | jq -r '.status'
    ```
  - If ALL `blockedBy` tickets are `done`:
    1. **Auto-Resolve Action:** Update blocked ticket to `done`:
       ```bash
       pa ticket update <TICKET-ID> --status done
       ```
    2. **Decision Log Entry:**
       ```bash
       echo "| <TICKET-ID> | BLOCKED (F1) | All blocking tickets (<blocking-ids>) are done | N/A | Closed: auto-resolved | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
       ```
    3. **Category:** BLOCKED-AUTO-RESOLVED
  - If any `blockedBy` ticket is NOT done: proceed to sub-ticket creation
- Create sub-ticket only if auto-resolve did not apply:
  ```bash
  pa ticket subticket create <TICKET-ID> \
    --title "BLOCKED: Waiting on dependencies" \
    --summary "Ticket has blocked tag or blockedBy: <blocking-ids>. Action: check blocking ticket status, unblock if resolved." \
    --assignee sinh --priority low --estimate XS \
    --actor builder/team-manager
  ```
- Category: BLOCKED (sub-ticket created or skipped)

#### PR Search

For tickets that pass the blocked check, search for matching PRs:

```bash
gh pr list --repo {{GH_REPO}} --state all --search "<TICKET-ID>" --json number,state,headRefName,mergeable,statusCheckRollup,mergedAt,closedAt,url
```

#### Pre-Decision: Stale Sub-Ticket Resolution (F6)

Before entering the decision tree, check if existing sub-tickets are **stale** — i.e., their triggering condition no longer applies. This prevents tickets from being permanently skipped due to outdated sub-tickets.

```bash
pa ticket subticket list <TICKET-ID>
```

For each **open** sub-ticket, cross-reference its type against the current PR state:

| Sub-Ticket Pattern | Current PR State | Stale? | Action |
|--------------------|-----------------|--------|--------|
| "CONFLICT: ..." | mergeable=MERGEABLE or state=MERGED | Yes | Close sub-ticket |
| "CI-FAILURE: ..." | checks=PASS or state=MERGED | Yes | Close sub-ticket |
| "READY-TO-MERGE: ..." | state=MERGED | Yes | Close sub-ticket |
| "ABANDONED: ..." | state=OPEN (PR reopened) | Yes | Close sub-ticket |
| "BLOCKED: ..." | All blockers resolved (done status) | Yes | Close sub-ticket |

**For each stale sub-ticket:**

1. **Close it:**
   ```bash
   pa ticket subticket complete <TICKET-ID> <SUB-TICKET-ID> --actor builder/team-manager
   ```

2. **Comment on parent ticket:**
   ```bash
   pa ticket comment <TICKET-ID> --author builder/team-manager --content "Auto-resolved stale sub-ticket <SUB-TICKET-ID> (<type>): condition no longer applies. PR #<number> is now <current-state>."
   ```

3. **Decision Log Entry:**
   ```bash
   echo "| <TICKET-ID> | STALE-RESOLVED (F6) | <SUB-TICKET-ID> (<type>) — PR now <state> | N/A | Auto-closed | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
   ```

**After resolving stale sub-tickets, continue to the Decision Tree.** The ticket may now be eligible for normal case processing (e.g., a ticket whose CONFLICT sub-ticket was stale now proceeds to Case B for READY-TO-MERGE handling).

#### Decision Tree

**CASE A — PR found, state=MERGED:**
- The ticket work is confirmed merged
- Update ticket to `done`:
  ```bash
  pa ticket update <TICKET-ID> --status done
  ```
- Add completion comment:
  ```bash
  pa ticket comment <TICKET-ID> --author builder/team-manager --content "Auto-closed: PR #<number> merged on <date>. Confirmed via gh."
  ```
- Category: CLOSED

**CASE B — PR found, state=OPEN, mergeable=MERGEABLE, checks=PASS:**
- **Pre-Merge CI Verification (secondary head-branch check):**
  1. Before merging, run secondary CI confirmation on the PR head branch:
     ```bash
     # Verify CI has a successful conclusion on the head branch before auto-merging
     HEAD_BRANCH_CI=$(gh run list --repo {{GH_REPO}} --workflow="CI" --branch <head-ref> --json conclusion,databaseId --limit 5 2>/dev/null)
     if [ -n "$HEAD_BRANCH_CI" ] && [ "$HEAD_BRANCH_CI" != "null" ]; then
       SUCCESS_COUNT=$(echo "$HEAD_BRANCH_CI" | jq '[.[] | select(.conclusion == "success")] | length')
       if [ "$SUCCESS_COUNT" -gt 0 ]; then
         # CI has run successfully on head branch, proceed to merge
         PRE_MERGE_CI_PASS=true
         HEAD_BRANCH_RUN_ID=$(echo "$HEAD_BRANCH_CI" | jq -r '[.[] | select(.conclusion == "success")] | .[0].databaseId')
       else
         # No successful CI on head branch — skip auto-merge, create CI-UNVERIFIED sub-ticket
         PRE_MERGE_CI_PASS=false
         HEAD_BRANCH_RUN_ID="none"
       fi
     else
       # Could not determine CI status — treat as unverified
       PRE_MERGE_CI_PASS=false
       HEAD_BRANCH_RUN_ID="unknown"
     fi
     ```
  2. **If PRE_MERGE_CI_PASS=false:**
     ```bash
     # Create CI-UNVERIFIED sub-ticket instead of auto-merging
     pa ticket subticket create <TICKET-ID> \
       --title "CI-UNVERIFIED: PR #<number> head branch has no successful CI run" \
       --summary "PR #<number> is MERGEABLE with passing checks but the head branch has no confirmed successful CI run (run ID: $HEAD_BRANCH_RUN_ID). Action: wait for CI to complete on head branch, verify success, then merge manually or re-run routine. PR URL: <url>" \
       --assignee sinh --priority high --estimate XS \
       --actor builder/team-manager
     # Decision Log Entry
     echo "| <TICKET-ID> | AUTO-MERGE-SKIPPED (B) | Head branch CI unverified (run: $HEAD_BRANCH_RUN_ID) | no | CI-UNVERIFIED sub-ticket created | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
     ```
     **Category:** AUTO-MERGE-SKIPPED-CI-UNVERIFIED
     Skip remaining steps for this ticket.
  3. **If PRE_MERGE_CI_PASS=true:** Proceed to merge.
- **Auto-Merge (immediate):**
  1. **Merge the PR:**
     ```bash
     gh pr merge <number> --repo {{GH_REPO}} --admin --merge
     ```
  2. **Poll GitHub Actions for merged commit (max 13 min with graceful extension):**
     ```bash
     # Get the merge commit SHA for accurate CI polling
     MERGE_COMMIT=$(gh api repos/:owner/:repo/pulls/<number>/merge --jq '.sha' 2>/dev/null)
     if [ -z "$MERGE_COMMIT" ] || [ "$MERGE_COMMIT" = "null" ]; then
       # Fall back to event+branch query if merge commit not available
       MERGE_COMMIT=""
     fi

     # Retry wrapper for gh API calls
     retry_gh_api() {
       local cmd="$1"
       local max_attempts=3
       local attempt=1
       local delay=5
       while [ $attempt -le $max_attempts ]; do
         result=$(eval "$cmd" 2>&1)
         exit_code=$?
         if [ $exit_code -eq 0 ] && [ -n "$result" ] && [ "$result" != "null" ]; then
           echo "$result"
           return 0
         fi
         if [ $attempt -lt $max_attempts ]; then
           sleep $delay
           delay=$((delay * 2))  # exponential backoff: 5s, 10s, 20s
         fi
         attempt=$((attempt + 1))
       done
       # All attempts failed
       echo "RETRY_EXHAUSTED"
       return 1
     }

     # Wait for CI to complete after merge
     # Poll every 30s, max 26 attempts (13 min total with 3-min grace extension)
     CI_POLL_COUNT=0
     CI_STATUS="unknown"
     CI_RUN_ID="none"
     CI_CONCLUSION="unknown"
     GRACE_USED=false
     MAX_ATTEMPTS=20
     GRACE_ATTEMPTS=6  # 3 extra minutes at 30s intervals

     while [ $CI_POLL_COUNT -lt $MAX_ATTEMPTS ]; do
       # Determine which query to use
       if [ -n "$MERGE_COMMIT" ] && [ "$MERGE_COMMIT" != "null" ]; then
         # Prefer merge commit SHA query (F3)
         RUN_RESULT=$(retry_gh_api "gh run list --repo {{GH_REPO}} --workflow='CI' --commit=$MERGE_COMMIT --json conclusion,databaseId --limit 1 2>/dev/null")
       else
         # Fall back to event+branch query
         RUN_RESULT=$(retry_gh_api "gh run list --repo {{GH_REPO}} --workflow='CI' --event=merge --branch=develop --json conclusion,databaseId --limit 1 2>/dev/null")
       fi

       if [ "$RUN_RESULT" != "RETRY_EXHAUSTED" ] && [ -n "$RUN_RESULT" ] && [ "$RUN_RESULT" != "null" ]; then
         CI_CONCLUSION=$(echo "$RUN_RESULT" | jq -r '.[0].conclusion // "null"')
         CI_RUN_ID=$(echo "$RUN_RESULT" | jq -r '.[0].databaseId // "none"')

         if [ "$CI_CONCLUSION" = "success" ]; then
           CI_STATUS="pass"
           break
         elif [ "$CI_CONCLUSION" = "failure" ] || [ "$CI_CONCLUSION" = "cancelled" ] || [ "$CI_CONCLUSION" = "timed_out" ]; then
           CI_STATUS="fail"
           break
         elif [ "$CI_CONCLUSION" = "null" ] || [ "$CI_CONCLUSION" = "in_progress" ] || [ "$CI_CONCLUSION" = "queued" ] || [ "$CI_CONCLUSION" = "waiting" ]; then
           # CI still running — check for grace period extension
           if [ $CI_POLL_COUNT -eq 19 ] && [ "$GRACE_USED" = "false" ]; then
             # At 10-min mark (20 attempts), check if CI shows recent activity (shared runners may be slow)
             # Extend by 3 minutes (6 more attempts at 30s)
             MAX_ATTEMPTS=$((MAX_ATTEMPTS + GRACE_ATTEMPTS))
             GRACE_USED=true
           fi
         fi
       fi
       sleep 30
       CI_POLL_COUNT=$((CI_POLL_COUNT + 1))
     done
     ```
  3. **Handle CI result:**
     - **If CI PASS (CI_STATUS="pass"):**
       ```bash
       # Close any existing READY-TO-MERGE sub-ticket
       pa ticket subticket complete <TICKET-ID> <SUB-TICKET-ID> --actor builder/team-manager 2>/dev/null || true
       # Return to develop and pull (CI verified, safe to pull)
       cd /home/sinh/git-repos/sinh-x/tools/personal-assistant
       git checkout develop
       git pull origin develop
       # Close parent ticket
       pa ticket update <TICKET-ID> --status done
       pa ticket comment <TICKET-ID> --author builder/team-manager --content "Auto-merged: PR #<number> merged (MERGEABLE + CI passing). CI verified post-merge via polling. Run ID: $CI_RUN_ID, Polling attempts: $CI_POLL_COUNT."
       # Decision Log Entry — updated format with CI Run ID, polling attempts, conclusion
       echo "| <TICKET-ID> | AUTO-MERGED (B) | PR MERGEABLE + CI passing | yes | PR #<number> merged, CI passed (run:$CI_RUN_ID, attempts:$CI_POLL_COUNT) | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
       ```
       **Category:** AUTO-MERGED
     - **If CI FAIL (CI_STATUS="fail"):**
       ```bash
       # Create CI-FAILURE sub-ticket (ticket NOT closed)
       pa ticket subticket create <TICKET-ID> \
         --title "CI-FAILURE: PR #<number> CI failed after merge" \
         --summary "PR #<number> was auto-merged but GitHub Actions CI failed after merge (run ID: $CI_RUN_ID). Action: review CI failure, fix code, revert if needed. PR URL: <url>" \
         --assignee sinh --priority high --estimate XS \
         --actor builder/team-manager
       # Return to develop and pull (but do NOT close ticket)
       cd /home/sinh/git-repos/sinh-x/tools/personal-assistant
       git checkout develop
       git pull origin develop
       # Decision Log Entry — updated format
       echo "| <TICKET-ID> | AUTO-MERGED (B) | PR merged, CI FAIL | no | CI failed post-merge (run:$CI_RUN_ID, attempts:$CI_POLL_COUNT), sub-ticket created | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
       ```
       **Category:** AUTO-MERGED-CI-FAIL
     - **If TIMEOUT (CI_STATUS="unknown" after 26 attempts = 13 min, or GRACE_USED and still no conclusion):**
       ```bash
       # Create CI-IN-PROGRESS sub-ticket (renamed from TIMEOUT — CI was still running at timeout)
       pa ticket subticket create <TICKET-ID> \
         --title "CI-IN-PROGRESS: PR #<number> CI verification timed out — CI still running" \
         --summary "PR #<number> was auto-merged but GitHub Actions CI did not complete within 13 minutes (ran $CI_POLL_COUNT polls, last run ID: $CI_RUN_ID, last conclusion: $CI_CONCLUSION). Action: verify CI status manually, proceed if healthy. PR URL: <url>" \
         --assignee sinh --priority medium --estimate XS \
         --actor builder/team-manager
       # Return to develop and pull
       cd /home/sinh/git-repos/sinh-x/tools/personal-assistant
       git checkout develop
       git pull origin develop
       # Decision Log Entry — updated format
       echo "| <TICKET-ID> | AUTO-MERGED (B) | PR merged, CI timeout | timeout | CI timeout at ${CI_POLL_COUNT} polls (run:$CI_RUN_ID, conclusion:$CI_CONCLUSION), CI-IN-PROGRESS sub-ticket created | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
       ```
       **Category:** AUTO-MERGED-CI-IN-PROGRESS
  4. **GitHub API Unreachable (graceful degradation):**
     ```bash
     # If gh run list fails after 3 retries (network/auth error), fall back to DEGRADED mode
     echo "WARNING: GitHub API unreachable for CI polling after 3 retries — falling back to DEGRADED mode (skip CI verification)" >&2
     cd /home/sinh/git-repos/sinh-x/tools/personal-assistant
     git checkout develop
     git pull origin develop
     pa ticket update <TICKET-ID> --status done
     pa ticket comment <TICKET-ID> --author builder/team-manager --content "Auto-merged: PR #<number> merged (DEGRADED: CI polling failed after 3 retries, proceeding without CI verification)."
     echo "| <TICKET-ID> | AUTO-MERGED (B) | PR merged, CI unreachable | degraded | DEGRADED: gh API failed after 3 retries, no CI verification | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
     ```
     **Category:** AUTO-MERGED-DEGRADED

**CASE C — PR found, state=OPEN, mergeable=CONFLICTING:**
- Check for existing sub-ticket:
  ```bash
  pa ticket subticket list <TICKET-ID>
  ```
- If open sub-ticket titled "CONFLICT: ..." exists: SKIP (record in SKIPPED)
- **Auto-Resolve Check (before creating sub-ticket):**
  - Attempt dry-run merge to detect conflict types:
    ```bash
    cd /home/sinh/git-repos/sinh-x/tools/personal-assistant
    git fetch origin <branch> <target-branch>
    git checkout <branch>
    git merge --no-commit --no-ff origin/<target-branch> 2>&1 | tee /tmp/merge-result.txt
    git merge --abort
    ```
  - If merge output shows conflicts in **non-code files only** (README, docs, config files matching `*.md`, `*.yaml`, `*.yml`, `*.json`, `*.toml`, `*.ini`, `*.cfg`):
    1. **Auto-Resolve Action:** Attempt auto-merge and push:
       ```bash
       git merge --no-commit --no-ff origin/<target-branch>
       git checkout --ours -- "*.md" "*.yaml" "*.yml" "*.json" "*.toml" "*.ini" "*.cfg"
       git add -A
       git commit -m "Merge <target-branch> into <branch> (auto-resolve non-code conflicts)"
       git push origin <branch>
       ```
    2. **Decision Log Entry:**
       ```bash
       echo "| <TICKET-ID> | CONFLICT (F2) | Non-code conflicts auto-resolved | N/A | Merged: <branch> into <target-branch> | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
       ```
    3. **Category:** CONFLICT-AUTO-RESOLVED
  - If conflicts involve code files, or merge fails: proceed to sub-ticket creation
- Create sub-ticket only if auto-resolve did not apply:
  ```bash
  pa ticket subticket create <TICKET-ID> \
    --title "CONFLICT: PR #<number> has merge conflicts" \
    --summary "PR #<number> targeting develop has merge conflicts. Action: resolve conflicts and push, or close PR and create new one. PR URL: <url>" \
    --assignee sinh --priority high --estimate XS \
    --actor builder/team-manager
  ```
- Category: CONFLICT (sub-ticket created or skipped)

**CASE D — PR found, state=OPEN, checks=FAILING:**
- Check for existing sub-ticket:
  ```bash
  pa ticket subticket list <TICKET-ID>
  ```
- If open sub-ticket titled "CI-FAILURE: ..." exists: SKIP (record in SKIPPED)
- **Auto-Resolve Check (before creating sub-ticket):**
  - Re-check CI status:
    ```bash
    gh pr check <TICKET-ID> --repo {{GH_REPO}} --json statusCheckRollup | jq '.statusCheckRollup[] | select(.conclusion == "FAILURE" or .conclusion == null)'
    ```
  - If ALL previously failing checks now show as **PASSED** (re-run succeeded):
    1. **Auto-Resolve Action:** Re-check PR state:
       ```bash
       gh pr view <TICKET-ID> --repo {{GH_REPO}} --json state,mergeable,statusCheckRollup
       ```
    2. If still OPEN and mergeable: proceed to READY-TO-MERGE handling
    3. **Decision Log Entry:**
       ```bash
       echo "| <TICKET-ID> | CI-FAILURE (auto-rerun) | Flaky test(s) passed on re-run | yes | Checks: <check-names> now PASSED | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
       ```
    4. **Category:** CI-FAILURE-AUTO-RESOLVED
  - If checks still failing or cannot determine: proceed to sub-ticket creation
- Create sub-ticket only if auto-resolve did not apply:
  ```bash
  pa ticket subticket create <TICKET-ID> \
    --title "CI-FAILURE: PR #<number> checks failing" \
    --summary "PR #<number> has failing CI checks: <check-names>. Action: review failures, fix code, push update. PR URL: <url>" \
    --assignee sinh --priority high --estimate XS \
    --actor builder/team-manager
  ```
- Category: CI-FAILURE (sub-ticket created or skipped)

**CASE E — PR found, state=CLOSED (not merged):**
- Do NOT close. Check for existing sub-ticket:
  ```bash
  pa ticket subticket list <TICKET-ID>
  ```
- If open sub-ticket titled "ABANDONED: ..." exists: SKIP (record in SKIPPED)
- Otherwise create sub-ticket:
  ```bash
  pa ticket subticket create <TICKET-ID> \
    --title "ABANDONED: PR #<number> closed without merge" \
    --summary "PR #<number> was closed without merging on <date>. Action: reopen PR, create new PR, or cancel parent ticket. PR URL: <url>" \
    --assignee sinh --priority medium --estimate XS \
    --actor builder/team-manager
  ```
- Category: ABANDONED (sub-ticket created or skipped)

**CASE F — No PR found, but commits exist on develop:**
- Fall back to git log search:
  ```bash
  git log {{DEVELOP_BRANCH}} --oneline --grep="<TICKET-ID>" | head -5
  ```
- **If commits found:** Direct-push commit (no PR). Close ticket:
  ```bash
  pa ticket update <TICKET-ID> --status done
  pa ticket comment <TICKET-ID> --author builder/team-manager --content "Auto-closed: Commits found on develop matching <TICKET-ID> (direct push, no PR). Commits: <list>."
  ```
- Category: CLOSED
- **If no commits found:** → Case G

**CASE G — No PR found AND no matching commits:**
- Check for existing sub-ticket:
  ```bash
  pa ticket subticket list <TICKET-ID>
  ```
- If open sub-ticket titled "ORPHAN: ..." exists: SKIP (record in SKIPPED)
- **Auto-Resolve Check (alternate branch patterns):**
  - Search for ticket ID in branch names:
    ```bash
    git branch -a --contains <TICKET-ID> 2>/dev/null || echo "No branches found"
    ```
  - Search for alternate branch naming patterns:
    ```bash
    git branch -a | grep -E "feature/.*<TICKET-ID>|fix/.*<TICKET-ID>|refactor/.*<TICKET-ID>" || echo "No alternate branches"
    ```
  - If work found on alternate branch:
    1. Verify the branch is merged into target:
       ```bash
       git log --oneline --grep="<TICKET-ID>" --all | head -5
       ```
    2. If commits found on develop or main: work was merged
    3. **Auto-Resolve Action:**
       ```bash
       pa ticket update <TICKET-ID> --status done
       pa ticket comment <TICKET-ID> --author builder/team-manager --content "Auto-closed: Found <TICKET-ID> work merged via alternate branch naming. Commits: <list>."
       ```
    4. **Decision Log Entry:**
       ```bash
       echo "| <TICKET-ID> | ORPHAN (F4) | Work verified via alternate branch pattern | N/A | Closed: merged | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
       ```
    5. **Category:** ORPHAN-AUTO-RESOLVED
  - If no work found: proceed to sub-ticket creation
- Create sub-ticket only if auto-resolve did not apply:
  ```bash
  pa ticket subticket create <TICKET-ID> \
    --title "ORPHAN: No PR or commits found" \
    --summary "No PR or commits found matching <TICKET-ID>. Action: verify work was done, check for alternate branch/commit naming, or reassign for implementation." \
    --assignee sinh --priority medium --estimate XS \
    --actor builder/team-manager
  ```
- Category: ORPHAN (sub-ticket created or skipped)

**CASE I — Multiple PRs found for same ticket:**
- Check if ANY PR is merged. If yes → Case A (close with note). If none merged:
  - Check for existing sub-ticket:
    ```bash
    pa ticket subticket list <TICKET-ID>
    ```
  - If open sub-ticket titled "MULTI-PR: ..." exists: SKIP (record in SKIPPED)
  - Otherwise create sub-ticket:
    ```bash
    pa ticket subticket create <TICKET-ID> \
      --title "MULTI-PR: Multiple open PRs" \
      --summary "Multiple PRs found: #<N1> (<state1>), #<N2> (<state2>). Action: determine canonical PR, close duplicates. URLs: <urls>" \
      --assignee sinh --priority medium --estimate XS \
      --actor builder/team-manager
    ```
- Category: CLOSED if any merged, MULTI-PR (sub-ticket created or skipped) if none merged

**CASE J — No PR found, no commits on develop, but linked branch exists (non-GitHub repo):**
- The orchestrator advanced the ticket to `review-uat` but skipped PR creation (non-GitHub repo). Routine handles local merge.
- Check for existing sub-ticket:
  ```bash
  pa ticket subticket list <TICKET-ID>
  ```
- If open sub-ticket titled "LOCAL-MERGE: ..." exists: SKIP (record in SKIPPED)
- **Auto-Resolve Check:** If linked branch is already merged into develop (git log shows the branch commits), close ticket:
  ```bash
  git log develop --oneline | grep "<TICKET-ID>"
  ```
- Otherwise perform local merge:
  ```bash
  cd /home/sinh/git-repos/sinh-x/tools/personal-assistant
  git checkout develop
  git merge --no-ff <linked-branch> -m "Merge <linked-branch> into develop (routine mode, after UAT)"
  git push origin develop
  ```
- Close ticket:
  ```bash
  pa ticket update <TICKET-ID> --status done
  pa ticket comment <TICKET-ID> --author builder/team-manager --content "Auto-closed: Local merge of <branch> into develop (non-GitHub repo, UAT approved)."
  ```
- Decision Log Entry:
  ```bash
  echo "| <TICKET-ID> | LOCAL-MERGE (J) | Non-GitHub repo, linked branch merged locally | N/A | Closed: done | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
  ```
- Category: LOCAL-MERGE
- If dry-run: preview the merge without executing it

#### Error Handling

During ticket processing, handle errors gracefully so one failure does not block others:

| Error Type | Action | Category |
|------------|--------|----------|
| `gh` CLI fails (auth/network) | Log error. Fall back to git-log-only detection. Note DEGRADED in summary header. | DEGRADED |
| `pa ticket update` fails | Log error, continue to next ticket | ERROR (per-ticket) |
| `pa ticket comment` fails | Log error, continue (non-critical) | — |
| `git log` fails | Log error, skip git-based detection | ERROR |
| Too many tickets (>20) | Process first 20 by priority. Note TRUNCATED in summary. | TRUNCATED |
| Timeout approaching (>4 min) | Stop processing. Produce partial summary. | TIMEOUT |

#### Per-Ticket Error Isolation

Process tickets in batch. If one ticket fails:
1. Log the error with ticket ID and error message
2. Continue to next ticket
3. Record in ERRORS section of summary
4. Do NOT abort the entire run

### Step 3.5 — Clean Merge Sub-Action (F5)

After processing all tickets, check if `clean` branch exists and merge it into `develop`:

```bash
cd /home/sinh/git-repos/sinh-x/tools/personal-assistant

# Check if clean branch exists
if git show-ref --quiet refs/heads/clean; then
  echo "Clean branch found, attempting merge into develop..."

  # Attempt dry-run merge first
  git checkout develop
  DRY_MERGE_OUTPUT=$(git merge --no-commit --no-ff clean 2>&1)
  MERGE_STATUS=$?

  if [ $MERGE_STATUS -eq 0 ]; then
    # Clean merge possible
    if [ "$DRY_RUN" = "true" ]; then
      echo "[DRY-RUN] Would merge clean into develop (no conflicts)"
      git merge --abort
    else
      git merge --no-ff clean -m "Merge clean into develop (routine mode)"
      git push origin develop
      echo "Clean branch merged into develop"
      # Log decision
      echo "| CLEAN-MERGE | F5 | Clean merge successful | N/A | develop <- clean | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
    fi
  else
    # Merge has conflicts
    git merge --abort
    if [ "$DRY_RUN" = "true" ]; then
      echo "[DRY-RUN] Would create CONFLICT sub-ticket for clean branch merge"
    else
      # Create sub-ticket for clean branch conflicts
      pa ticket subticket create PA-0000 \
        --title "CONFLICT: clean branch has merge conflicts with develop" \
        --summary "Clean branch cannot be auto-merged into develop due to conflicts. Action: resolve manually. Conflicts detected in: $(echo $DRY_MERGE_OUTPUT | grep -E 'CONFLICT|conflict')" \
        --assignee sinh --priority medium --estimate XS \
        --actor builder/team-manager
      echo "| CLEAN-MERGE | F5 | Conflicts detected | N/A | Sub-ticket created | $(date -Iseconds) |" >> ~/Documents/ai-usage/deployments/$PA_DEPLOYMENT_ID/routine-decisions-$(date +%Y-%m-%d).md
    fi
  fi
else
  echo "Clean branch not found, skipping clean-merge"
fi
```

**Decision Log Entry (for each clean-merge attempt):**
See template in Step 4 summary section.

---

### Step 3.6 — Return to develop and pull

After all ticket processing and clean-merge steps, ensure the local repo is on `develop` with the latest remote state:

```bash
cd /home/sinh/git-repos/sinh-x/tools/personal-assistant
git checkout develop
git pull origin develop
```

This keeps the working tree clean for the next deployment and ensures any PRs merged during this run are reflected locally.

---

### Step 4 — Produce Structured Summary

After processing all tickets, produce a structured summary as a ticket comment on the last processed ticket (or create an FYI ticket if no tickets were processed):

**Summary Template:**

```
## Routine Mode Summary — d-<deployment-id>

**Mode:** routine | **Runtime:** <elapsed> | **Provider:** MiniMax
**Dry-Run:** [true/false]

---
### AUTO-RESOLVED: N tickets
| Ticket | Rule | Evidence | Outcome | Timestamp |
|--------|------|----------|---------|-----------|
| PA-XXXX | F1: BLOCKED resolved | All blocking tickets done | Closed: auto-resolved | YYYY-MM-DD |
| PA-XXXX | F2: CONFLICT auto-merge | Non-code conflicts only | Merged: branch into target | YYYY-MM-DD |
| PA-XXXX | F3: READY-TO-MERGE grace | PR older than grace period | Merged via gh | YYYY-MM-DD |
| PA-XXXX | F4: ORPHAN alternate branch | Work found on feature/* branch | Closed: merged | YYYY-MM-DD |
| PA-XXXX | CI-FAILURE rerun | Flaky tests now passing | Checks PASS | YYYY-MM-DD |
| PA-XXXX | F6: Stale CONFLICT resolved | PR now MERGEABLE | Sub-ticket closed | YYYY-MM-DD |
| PA-XXXX | F6: Stale CI-FAILURE resolved | Checks now PASS | Sub-ticket closed | YYYY-MM-DD |
| PA-XXXX | F6: Stale READY-TO-MERGE resolved | PR now MERGED | Sub-ticket closed | YYYY-MM-DD |

---
### CLOSED: N tickets
| Ticket | PR/Commit | Note |
|--------|-----------|------|
| PA-XXXX | PR #N (merged <date>) | Via gh |
| PA-XXXX | commits (direct push) | Via git log |

---
### SUB-TICKETS CREATED: N
| Parent | Anomaly | Sub-Ticket ID | Action |
|--------|---------|---------------|--------|
| PA-XXXX | READY-TO-MERGE | PA-XXXX-ST-1 | Review and merge PR #N |
| PA-XXXX | CONFLICT | PA-XXXX-ST-1 | Resolve merge conflicts |
| PA-XXXX | CI-FAILURE | PA-XXXX-ST-1 | Fix failing CI checks |
| PA-XXXX | ABANDONED | PA-XXXX-ST-1 | Reopen or cancel |
| PA-XXXX | ORPHAN | PA-XXXX-ST-1 | Verify work status |
| PA-XXXX | BLOCKED | PA-XXXX-ST-1 | Check blocking deps |
| PA-XXXX | MULTI-PR | PA-XXXX-ST-1 | Determine canonical PR |

### SKIPPED (existing sub-tickets): N
| Parent | Anomaly | Existing Sub-Ticket | Status |
|--------|---------|---------------------|--------|
| PA-XXXX | CONFLICT | PA-XXXX-ST-2 | open |
| PA-XXXX | ORPHAN | PA-XXXX-ST-1 | open |

---
### ERRORS: N tickets
| Ticket | Error |
|--------|-------|
| PA-XXXX | <error message> |

---
**NOTES:** [DEGRADED / TRUNCATED / TIMEOUT if applicable]
```

**If no tickets to process:** Post comment noting "0 tickets processed, none pending."

### Step 5 — Session Log and Registry Completion

Write your session log per the `pa-session-log` skill, then write the registry completion marker.

#### Session Log

Save to: `~/Documents/ai-usage/sessions/$(date +%Y)/$(date +%m)/agent-team/`

Filename format: `YYYY-MM-DD-<6char-hash>-builder--team-manager--<TICKET-ID>--routine-close.md`

Required sections: `# AI Session Log`, header blockquote, `## Timeline`, `## What Happened`, `## Results`, `## Session Rating` (with self-rated scores), `## Work Quality Metrics`, `## Self-Improvement`, `## Tags`.

#### Registry Completion Marker

```bash
pa registry complete $PA_DEPLOYMENT_ID \
  --status success \
  --summary "<1-sentence summary>" \
  --log-file ~/Documents/ai-usage/sessions/YYYY/MM/agent-team/<filename>.md \
  --rating-source agent \
  --rating-overall N \
  --rating-productivity N \
  --rating-quality N \
  --rating-efficiency N \
  --rating-insight N
```

---

## Rules

- **Solo operator.** Do not spawn sub-agents.
- **No destructive git operations.** Read-only git access — only ticket status changes are made.
- **Per-ticket error isolation.** One ticket's failure must not block others. Log errors and continue.
- **Graceful degradation.** If `gh` CLI fails, fall back to git-log-only and note DEGRADED mode.
- **Dedup before sub-ticket.** Always check `pa ticket subticket list` before creating a new sub-ticket. Skip if matching open sub-ticket exists.
- **Never close anomaly tickets.** Tickets with CONFLICT, CI-FAILURE, ABANDONED, ORPHAN, MULTI-PR, or BLOCKED status are NOT closed — create sub-tickets instead.
- **One sub-ticket per anomaly type.** Each ticket gets at most one open sub-ticket per anomaly type (dedup prevents duplicates).
- **Graceful handling of empty results.** If no `review-uat` tickets are found, produce an FYI noting "0 tickets processed, none pending".
- **20-ticket cap.** Process by priority (critical > high > medium > low). Note TRUNCATED if over 20.
- **Copyable pattern.** Other teams can copy this objective file and adapt for their own use.
- **Dry-run mode.** When `PA_DRY_RUN=true`, preview all auto-resolve decisions without executing them. Set via `pa deploy builder --mode routine --dry-run`.
- **NF3 Fail-safe.** If any auto-resolve verification step fails, fall back to sub-ticket creation. Never auto-close a ticket if verification cannot confirm the condition.
- **Auto-resolve before sub-ticket.** Always attempt auto-resolve before creating sub-tickets for BLOCKED, CONFLICT, CI-FAILURE, ORPHAN, and READY-TO-MERGE cases.
- **Stale sub-ticket resolution (F6).** Before entering the decision tree, cross-reference existing open sub-tickets against current PR state. Close sub-tickets whose triggering condition no longer applies (e.g., CONFLICT sub-ticket when PR is now MERGEABLE). After cleanup, re-evaluate the ticket through the normal decision tree.
- **Orchestrator-created PRs.** When the orchestrator creates a PR and advances the ticket to `review-uat`, routine mode processes these PRs in the normal Case A/B flow. After Sinh reviews the UAT, the next routine run auto-merges qualifying PRs (Case B) or closes tickets with already-merged PRs (Case A). No special handling is needed for orchestrator-created PRs.
- **Non-GitHub repos.** Repos without GitHub remotes are handled by Case J (local merge). The orchestrator advances the ticket to `review-uat` with a linked branch but no PR. Routine detects this and performs a local `git merge --no-ff`.

---

## Skill References

| Skill | Path | When to use |
|-------|------|-------------|
| pa-cli | `~/.claude/skills/pa-cli/SKILL.md` | `pa ticket` commands, enum values |
| pa-session-log | `~/.claude/skills/pa-session-log/SKILL.md` | Session log template, artifact finalization |
| pa-ticket-workflow | `~/.claude/skills/pa-ticket-workflow/SKILL.md` | Ticket lifecycle, status transitions |
| pa-startup | `~/.claude/skills/pa-startup/SKILL.md` | Startup priority order |
| pa-self-improvement | `~/.claude/skills/pa-self-improvement/SKILL.md` | Self-improvement framework |
| pa-registry | `~/.claude/skills/pa-registry/SKILL.md` | Completion marker writing |

---

## Template Pattern (for other teams)

To create a similar routine mode for another team, copy this file and change:

1. **`teams/<team>/modes/<mode>.md`** — create new mode objective
2. **`teams/<team>.yaml`** — add mode entry with `id: <mode>`, `phone_visible: true`, `provider: minimax`, `mode_type: work`, `agents: []`, `objective: teams/<team>/modes/<mode>.md`
3. **Adapt `gh pr list --repo`** and `git log` commands for the target repo
4. **Adapt ticket project/assignee filters** as needed
5. **Add skills** matching the standard skill set above

The core logic (fetch tickets → cross-reference with gh → close confirmed → produce FYI summary) is repo-agnostic and can be reused across teams.
