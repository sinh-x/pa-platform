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

exit $failed
