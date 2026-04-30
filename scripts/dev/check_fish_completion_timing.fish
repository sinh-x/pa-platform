#!/usr/bin/env fish

set -l script_dir (dirname (status filename))
set -l repo_root (cd "$script_dir/../.."; and pwd)
set -l completion_file "$repo_root/completions/opa.fish"

if not test -f "$completion_file"
    echo "Missing generated completion file: $completion_file" >&2
    exit 1
end

complete -c opa -e
source "$completion_file"

function __opa_completion_threshold --argument-names env_name default_ms
    set -l threshold $default_ms
    if set -q $env_name
        set threshold $$env_name
    end

    if not string match -rq '^[0-9]+$' -- "$threshold"
        echo "Invalid threshold $env_name=$threshold; expected milliseconds as an integer" >&2
        exit 1
    end

    echo $threshold
end

function __opa_completion_elapsed_ms --argument-names commandline
    set -l start (date +%s%3N)
    complete -C "$commandline" >/dev/null
    set -l end (date +%s%3N)
    math "$end - $start"
end

function __opa_completion_check --argument-names name commandline threshold
    complete -C "$commandline" >/dev/null

    set -l runs
    for run in 1 2 3
        set -a runs (__opa_completion_elapsed_ms "$commandline")
    end

    set -l sorted (printf '%s\n' $runs | sort -n)
    set -l median $sorted[2]
    set -l result_status pass
    set -l exit_code 0

    if test "$median" -gt "$threshold"
        set result_status fail
        set exit_code 1
    end

    printf '%-15s median=%sms threshold=%sms status=%s\n' "$name" "$median" "$threshold" "$result_status"
    return $exit_code
end

set -l failed 0

printf '%-15s %-12s %-15s %s\n' scenario median threshold status
printf '%-15s %-12s %-15s %s\n' -------- ------ --------- ------

__opa_completion_check top-level 'opa ' (__opa_completion_threshold OPA_FISH_COMPLETION_THRESHOLD_TOP_LEVEL_MS 1000); or set failed 1
__opa_completion_check deploy 'opa deploy ' (__opa_completion_threshold OPA_FISH_COMPLETION_THRESHOLD_DEPLOY_MS 5000); or set failed 1
__opa_completion_check status 'opa status ' (__opa_completion_threshold OPA_FISH_COMPLETION_THRESHOLD_STATUS_MS 2500); or set failed 1
__opa_completion_check ticket-show 'opa ticket show ' (__opa_completion_threshold OPA_FISH_COMPLETION_THRESHOLD_TICKET_SHOW_MS 2000); or set failed 1
__opa_completion_check board-assignee 'opa board --assignee ' (__opa_completion_threshold OPA_FISH_COMPLETION_THRESHOLD_BOARD_ASSIGNEE_MS 3000); or set failed 1

function __completion_candidate_names --argument-names commandline
    complete -C "$commandline" | string replace -r '\t.*$' ''
end

function __completion_expect_contains --argument-names name commandline expected
    set -l candidates (__completion_candidate_names "$commandline")
    if contains -- "$expected" $candidates
        printf '%-15s expected=%s status=pass\n' "$name" "$expected"
        return 0
    end

    printf '%-15s expected=%s status=fail\n' "$name" "$expected"
    printf '  commandline: %s\n' "$commandline"
    printf '  candidates: %s\n' (string join ', ' $candidates)
    return 1
end

function __completion_expect_not_contains --argument-names name commandline unexpected
    set -l candidates (__completion_candidate_names "$commandline")
    if not contains -- "$unexpected" $candidates
        printf '%-15s unexpected=%s status=pass\n' "$name" "$unexpected"
        return 0
    end

    printf '%-15s unexpected=%s status=fail\n' "$name" "$unexpected"
    printf '  commandline: %s\n' "$commandline"
    printf '  candidates: %s\n' (string join ', ' $candidates)
    return 1
end

functions -e __opa_projects __opa_ticket_ids __opa_deployments __opa_teams
function __opa_projects
    printf '%s\n' pa-platform
end
function __opa_ticket_ids
    printf '%s\n' PAP-016
end
function __opa_deployments
    printf '%s\n' d-123456
end
function __opa_teams
    printf '%s\n' builder requirements
end

__completion_expect_contains opa-deploy-team 'opa deploy ' builder; or set failed 1
__completion_expect_contains opa-deploy-req 'opa deploy ' requirements; or set failed 1
__completion_expect_contains opa-deploy-mode 'opa deploy builder ' --mode; or set failed 1
__completion_expect_contains opa-deploy-obj 'opa deploy builder ' --objective; or set failed 1
__completion_expect_contains opa-deploy-repo 'opa deploy builder ' --repo; or set failed 1
__completion_expect_contains opa-deploy-ticket 'opa deploy builder ' --ticket; or set failed 1
__completion_expect_contains opa-deploy-dry 'opa deploy builder ' --dry-run; or set failed 1
__completion_expect_contains opa-deploy-bg 'opa deploy builder ' --background; or set failed 1
__completion_expect_contains opa-mode-impl 'opa deploy builder --mode ' implement; or set failed 1
__completion_expect_contains opa-mode-orch 'opa deploy builder --mode ' orchestrator; or set failed 1
__completion_expect_contains opa-mode-routine 'opa deploy builder --mode ' routine; or set failed 1
__completion_expect_contains opa-team-repo-val 'opa deploy builder --repo ' pa-platform; or set failed 1
__completion_expect_contains opa-team-ticket-val 'opa deploy builder --ticket ' PAP-016; or set failed 1
__completion_expect_contains opa-repo-value 'opa deploy --repo ' pa-platform; or set failed 1
__completion_expect_not_contains opa-repo-post 'opa deploy --repo pa-platform ' pa-platform; or set failed 1
__completion_expect_contains opa-repo-post-team 'opa deploy --repo pa-platform ' builder; or set failed 1
__completion_expect_contains opa-ticket-value 'opa deploy --ticket ' PAP-016; or set failed 1
__completion_expect_not_contains opa-ticket-post 'opa deploy --ticket PAP-016 ' PAP-016; or set failed 1
__completion_expect_contains opa-ticket-post-team 'opa deploy --ticket PAP-016 ' builder; or set failed 1
__completion_expect_contains opa-resume-value 'opa deploy --resume ' d-123456; or set failed 1
__completion_expect_not_contains opa-resume-post 'opa deploy --resume d-123456 ' d-123456; or set failed 1

set -l pa_core_completion_file "$repo_root/completions/pa-core.fish"
if not test -f "$pa_core_completion_file"
    echo "Missing source completion file: $pa_core_completion_file" >&2
    exit 1
end

complete -c pa-core -e
source "$pa_core_completion_file"

functions -e __pa_core_projects __pa_core_ticket_ids __pa_core_teams
function __pa_core_projects
    printf '%s\n' pa-platform
end
function __pa_core_ticket_ids
    printf '%s\n' PAP-016
end
function __pa_core_teams
    printf '%s\n' builder
end

__completion_expect_contains pa-repo-value 'pa-core deploy --repo ' pa-platform; or set failed 1
__completion_expect_not_contains pa-repo-post 'pa-core deploy --repo pa-platform ' pa-platform; or set failed 1
__completion_expect_contains pa-repo-post-team 'pa-core deploy --repo pa-platform ' builder; or set failed 1
__completion_expect_contains pa-ticket-value 'pa-core deploy --ticket ' PAP-016; or set failed 1
__completion_expect_not_contains pa-ticket-post 'pa-core deploy --ticket PAP-016 ' PAP-016; or set failed 1
__completion_expect_contains pa-ticket-post-team 'pa-core deploy --ticket PAP-016 ' builder; or set failed 1

exit $failed
