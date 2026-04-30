# Fish completions for pa-core

set -g __pa_core_completion_dir (dirname (status filename))

function __pa_core_config_value --argument-names key
    set -l config_dir ~/.config/sinh-x/pa-platform
    if set -q PA_PLATFORM_CONFIG
        set config_dir "$PA_PLATFORM_CONFIG"
    end

    set -l config_file "$config_dir/config.yaml"
    if test -f "$config_file"
        string match -r "^\\s*$key:\\s*.+\$" < "$config_file" | string replace -r "^\\s*$key:\\s*" '' | string trim -c ' "' | string replace -r '^~(?=/|$)' "$HOME"
    end
end

function __pa_core_team_dirs
    set -l dirs
    if set -q PA_PLATFORM_TEAMS; and test -d "$PA_PLATFORM_TEAMS"
        set -a dirs "$PA_PLATFORM_TEAMS"
    end

    set -l configured_teams (__pa_core_config_value teams_dir)
    if test -d "$configured_teams"
        set -a dirs "$configured_teams"
    end

    set -l configured_home (__pa_core_config_value config_dir)
    if test -d "$configured_home/teams"
        set -a dirs "$configured_home/teams"
    end

    if set -q PA_PLATFORM_HOME; and test -d "$PA_PLATFORM_HOME/teams"
        set -a dirs "$PA_PLATFORM_HOME/teams"
    end

    set -l source_teams $__pa_core_completion_dir/../teams
    if test -d "$source_teams"
        set -a dirs "$source_teams"
    end

    set -l installed_teams $__pa_core_completion_dir/../../pa-platform/teams
    if test -d "$installed_teams"
        set -a dirs "$installed_teams"
    end

    if test -d ~/.config/sinh-x/pa-platform/teams
        set -a dirs ~/.config/sinh-x/pa-platform/teams
    end

    printf '%s\n' $dirs
end

function __pa_core_teams
    set -l dirs (__pa_core_team_dirs)

    for dir in $dirs
        for file in $dir/*.yaml
            if test -f "$file"
                basename "$file" .yaml
            end
        end
    end | sort -u
end

function __pa_core_deploy_team_candidates
    set -l dirs (__pa_core_team_dirs)
    for dir in $dirs
        for file in $dir/*.yaml
            if test -f "$file"
                basename "$file" .yaml
            end
        end
    end | sort -u
end

function __pa_core_team_file
    set -l team_name $argv[1]
    test -z "$team_name"; and return

    set -l dirs (__pa_core_team_dirs)
    for dir in $dirs
        set -l file "$dir/$team_name.yaml"
        if test -f "$file"
            printf '%s\n' "$file"
            return
        end
    end
end

function __pa_core_modes
    set -l team_name (__pa_core_deploy_team_name)
    test -z "$team_name"; and return

    set -l team_file (__pa_core_team_file "$team_name")
    if test -n "$team_file"
        set -l modes (string match -r '^\s+-\s+id:\s*.+$' < "$team_file" | string replace -r '^\s+-\s+id:\s*' '' | string trim -c ' "')
        if test (count $modes) -gt 0
            printf '%s\n' $modes
            return
        end
    end

    if command -q pa-core
        set -l modes (pa-core deploy "$team_name" --list-modes 2>/dev/null | awk 'NR>1 && $1 != "" {id=$1; $1=""; sub(/^[[:space:]]+/, ""); print id "\t" $0}')
        if test (count $modes) -gt 0
            printf '%s\n' $modes
            return
        end
    end
end

function __pa_core_projects
    pa-core repos list 2>/dev/null | awk 'NR>2 && NF>0 {print $1}'
end

function __pa_core_deployments
    command -q pa-core; or return

    pa-core registry list --limit 100 2>/dev/null | awk 'NR>2 && $1 ~ /^d-/ {
        id = substr($0, 1, 12);
        team = substr($0, 14, 22);
        status = substr($0, 37, 10);
        summary = substr($0, 90);
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", id);
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", team);
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", status);
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", summary);
        if (summary == "") summary = "(no summary)";
        print id "\t" team " - " status " - " summary;
    }'
end

function __pa_core_ticket_ids
    command -q pa-core; or return

    pa-core ticket list 2>/dev/null | awk '/^[A-Z][A-Z0-9]*-[0-9]+[[:space:]]/ {
        id = $1;
        $1 = $2 = $3 = $4 = "";
        sub(/^[[:space:]]+/, "");
        if ($0 == "") $0 = "Ticket";
        print id "\t" $0;
    }'
end

function __pa_core_bulletin_ids
    pa-core bulletin list 2>/dev/null | string match -rg 'B-[0-9]+'
end

function __pa_core_trash_ids
    pa-core trash list 2>/dev/null | string match -rg '^T-[0-9]+'
end

function __pa_core_timer_names
    systemctl --user list-timers 'pa-*' --no-legend 2>/dev/null | string match -r 'pa-\S+\.timer' | string replace -r '^pa-' '' | string replace -r '\.timer$' '' | sort -u
end

function __pa_core_assignees
    printf '%s\n' (__pa_core_teams) sinh builder/team-manager | sort -u
end

function __pa_core_completing_option_value
    set -l option $argv[1]
    set -l tokens (commandline -opc)
    test (count $tokens) -gt 0; or return 1
    test "$tokens[-1]" = "$option"
end

function __pa_core_deploy_option_expects_value
    switch $argv[1]
        case --mode --objective --repo --ticket --timeout
            return 0
    end

    return 1
end

function __pa_core_deploy_is_context
    set -l tokens (commandline -opc)
    test (count $tokens) -ge 2; or return 1
    test "$tokens[2]" = deploy
end

function __pa_core_deploy_team_name
    __pa_core_deploy_is_context; or return 1

    set -l tokens (commandline -opc)
    set -l expecting_value false

    for token in $tokens[3..-1]
        if test "$expecting_value" = true
            set expecting_value false
            continue
        end

        if string match -q -- '-*' $token
            if __pa_core_deploy_option_expects_value "$token"
                set expecting_value true
            end
            continue
        end

        printf '%s\n' "$token"
        return 0
    end

    return 1
end

function __pa_core_deploy_has_team
    set -l team_name (__pa_core_deploy_team_name)
    test -n "$team_name"; or return 1
    contains -- "$team_name" (__pa_core_deploy_team_candidates)
end

function __pa_core_deploy_completing_option_value
    __pa_core_deploy_is_context; or return 1

    set -l tokens (commandline -opc)
    test (count $tokens) -gt 0; or return 1
    __pa_core_deploy_option_expects_value "$tokens[-1]"
end

function __pa_core_deploy_needs_team
    __pa_core_deploy_is_context; or return 1
    __pa_core_deploy_completing_option_value; and return 1
    __pa_core_deploy_has_team; and return 1
    return 0
end

function __pa_core_deploy_should_offer_options
    __pa_core_deploy_is_context; or return 1
    __pa_core_deploy_has_team; or return 1
    __pa_core_deploy_completing_option_value; and return 1
    return 0
end

function __pa_core_deploy_completing
    __pa_core_deploy_is_context
end

complete -c pa-core -f

complete -c pa-core -n __fish_use_subcommand -a repos -d 'Manage repositories'
complete -c pa-core -n __fish_use_subcommand -a status -d 'Show deployment status'
complete -c pa-core -n __fish_use_subcommand -a deploy -d 'Deploy an agent team'
complete -c pa-core -n __fish_use_subcommand -a serve -d 'Start API server through adapter hook'
complete -c pa-core -n __fish_use_subcommand -a stop -d 'Stop API server through adapter hook'
complete -c pa-core -n __fish_use_subcommand -a restart -d 'Restart API server through adapter hook'
complete -c pa-core -n __fish_use_subcommand -a serve-status -d 'Show API server status through adapter hook'
complete -c pa-core -n '__fish_seen_subcommand_from serve; and not __fish_seen_subcommand_from stop restart status' -a 'stop restart status' -d 'Serve action'
complete -c pa-core -n __fish_use_subcommand -a schedule -d 'Schedule a systemd timer'
complete -c pa-core -n __fish_use_subcommand -a timers -d 'List PA systemd timers'
complete -c pa-core -n __fish_use_subcommand -a remove-timer -d 'Remove a systemd timer'
complete -c pa-core -n __fish_use_subcommand -a board -d 'Show kanban board'
complete -c pa-core -n __fish_use_subcommand -a teams -d 'List teams'
complete -c pa-core -n __fish_use_subcommand -a registry -d 'Manage deployment registry'
complete -c pa-core -n __fish_use_subcommand -a ticket -d 'Manage tickets'
complete -c pa-core -n __fish_use_subcommand -a bulletin -d 'Manage bulletins'
complete -c pa-core -n __fish_use_subcommand -a health -d 'Generate health report'
complete -c pa-core -n __fish_use_subcommand -a trash -d 'Manage trash'
complete -c pa-core -n __fish_use_subcommand -a codectx -d 'Analyze and query code context'
complete -c pa-core -n __fish_use_subcommand -a signal -d 'Collect Signal Note to Self messages'

complete -c pa-core -n '__fish_seen_subcommand_from repos; and not __fish_seen_subcommand_from list' -a list -d 'List repositories'

complete -c pa-core -n __pa_core_deploy_needs_team -a '(__pa_core_deploy_team_candidates)' -d 'Team name'
complete -c pa-core -f -n __pa_core_deploy_should_offer_options -a '--mode --objective --background --dry-run --repo --ticket --timeout' -d 'Deploy option'
complete -c pa-core -f -n __pa_core_deploy_completing -l mode -d 'Deploy mode' -r -a '(__pa_core_modes)'
complete -c pa-core -n __pa_core_deploy_completing -l objective -d 'Deployment objective' -r
complete -c pa-core -n __pa_core_deploy_completing -l background -d 'Run detached/headless'
complete -c pa-core -n __pa_core_deploy_completing -l dry-run -d 'Generate primer without invoking runtime'
complete -c pa-core -f -n __pa_core_deploy_completing -l repo -d 'Repository name' -r -a '(__pa_core_projects)'
complete -c pa-core -f -n __pa_core_deploy_completing -l ticket -d 'Ticket ID' -r -a '(__pa_core_ticket_ids)'
complete -c pa-core -n __pa_core_deploy_completing -l timeout -d 'Timeout seconds' -r

complete -c pa-core -n '__fish_seen_subcommand_from status; and string match -q "d-*" -- (commandline -ct)' -a '(__pa_core_deployments)' -d 'Deployment'
complete -c pa-core -n '__fish_seen_subcommand_from status' -l running -d 'Only running deployments'
complete -c pa-core -n '__fish_seen_subcommand_from status' -l today -d 'Only today deployments'
complete -c pa-core -n '__fish_seen_subcommand_from status' -l team -d 'Filter by team' -r -a '(__pa_core_teams)'
complete -c pa-core -n '__fish_seen_subcommand_from status' -l recent -d 'Limit recent deployments' -r
complete -c pa-core -n '__fish_seen_subcommand_from status' -l wait -d 'Check whether deployment is terminal'
complete -c pa-core -n '__fish_seen_subcommand_from status' -l report -d 'Show work report for deployment'
complete -c pa-core -n '__fish_seen_subcommand_from status' -l artifacts -d 'List deployment artifact files'
complete -c pa-core -n '__fish_seen_subcommand_from status' -l activity -d 'Show deployment activity timeline'

complete -c pa-core -n '__fish_seen_subcommand_from schedule; and test (count (commandline -opc)) -eq 2' -a '(__pa_core_teams) daily:plan daily:progress daily:end signal:collect' -d 'Schedule spec'
complete -c pa-core -f -n '__fish_seen_subcommand_from schedule; and test (count (commandline -opc)) -eq 3' -a 'hourly daily weekly monthly' -d 'Repeat interval'
complete -c pa-core -f -n '__fish_seen_subcommand_from schedule' -l repeat -d 'Repeat interval' -r -a 'hourly daily weekly monthly'
complete -c pa-core -n '__fish_seen_subcommand_from schedule' -l time -d 'Time HH:MM' -r
complete -c pa-core -n '__fish_seen_subcommand_from schedule' -l command -d 'Command written to systemd unit' -r
complete -c pa-core -n '__fish_seen_subcommand_from schedule' -l dry-run -d 'Preview systemd units without writing'
complete -c pa-core -n '__fish_seen_subcommand_from remove-timer' -a '(__pa_core_timer_names)' -d 'Timer name'
complete -c pa-core -n '__fish_seen_subcommand_from remove-timer' -l dry-run -d 'Preview removal'
complete -c pa-core -n '__fish_seen_subcommand_from remove-timer' -l yes -d 'Confirm removal'

complete -c pa-core -n '__fish_seen_subcommand_from board' -l project -d 'Filter by project' -r
complete -c pa-core -n '__fish_seen_subcommand_from board; and __pa_core_completing_option_value --project' -a '(__pa_core_projects)'
complete -c pa-core -n '__fish_seen_subcommand_from board' -l assignee -d 'Filter by assignee' -r -a '(__pa_core_assignees)'
complete -c pa-core -n '__fish_seen_subcommand_from board' -l all -d 'Accepted for compatibility'

complete -c pa-core -n '__fish_seen_subcommand_from teams; and not __fish_seen_subcommand_from (__pa_core_teams)' -a '(__pa_core_teams)' -d 'Team name'
complete -c pa-core -n '__fish_seen_subcommand_from teams' -l all -d 'Include backlog and archived tickets'

complete -c pa-core -n '__fish_seen_subcommand_from registry; and not __fish_seen_subcommand_from list show complete update amend search analytics clean sweep' -a 'list show complete update amend search analytics clean sweep'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from show complete update amend' -a '(__pa_core_deployments)' -d 'Deployment ID'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from list' -l team -d 'Filter by team' -r -a '(__pa_core_teams)'
complete -c pa-core -f -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from list' -l status -d 'Filter by status' -r -a 'running success partial failed crashed dead unknown'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from list' -l since -d 'Filter since date' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from list search' -l limit -d 'Limit results' -r
complete -c pa-core -f -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l status -d 'Completion status' -r -a 'success partial failed'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update amend' -l summary -d 'Summary text' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update amend' -l log-file -d 'Session log path' -r
complete -c pa-core -f -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-source -d 'Rating source' -r -a 'agent system user'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-overall -d 'Overall rating 0-5' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-productivity -d 'Productivity rating 0-5' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-quality -d 'Quality rating 0-5' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-efficiency -d 'Efficiency rating 0-5' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-insight -d 'Insight rating 0-5' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete' -l fallback -d 'Fallback completion marker'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from update' -l note -d 'Free-text update note' -r
complete -c pa-core -f -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from analytics' -l view -d 'Analytics view' -r -a 'daily teams ratings'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from analytics' -l team -d 'Filter by team' -r -a '(__pa_core_teams)'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from analytics' -l since -d 'Filter since date' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from clean' -l threshold -d 'Orphan threshold hours' -r
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from clean' -l dry-run -d 'Preview only'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from clean' -l mark-dead -d 'Mark orphans as crashed'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from sweep' -l dry-run -d 'Preview only'
complete -c pa-core -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from sweep' -l fix -d 'Write fallback markers'

complete -c pa-core -n '__fish_seen_subcommand_from ticket; and not __fish_seen_subcommand_from create update list show attach comment move delete check-refs subticket' -a 'create update list show attach comment move delete check-refs subticket'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from show update attach comment move delete' -a '(__pa_core_ticket_ids)'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create' -l project -d 'Project' -r -a '(__pa_core_projects)'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create' -l title -d 'Title' -r
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list' -l type -d 'Ticket type' -r -a 'feature bug task review-request work-report fyi idea question'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list update' -l priority -d 'Priority' -r -a 'critical high medium low'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create update' -l estimate -d 'Estimate' -r -a 'XS S M L XL'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list update' -l assignee -d 'Assignee' -r -a '(__pa_core_assignees)'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create' -l summary -d 'Summary' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create' -l description -d 'Description' -r
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list update' -l status -d 'Status' -r -a 'idea requirement-review pending-approval pending-implementation implementing review-uat done rejected cancelled'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list update' -l tags -d 'Tags' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from list' -l project -d 'Project' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from list; and __pa_core_completing_option_value --project' -a '(__pa_core_projects)'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from list' -l search -d 'Search text' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from list' -l exclude-tags -d 'Excluded tags' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from show' -l json -d 'Output JSON'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update create comment move delete attach' -l actor -d 'Actor' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l blocked-by -d 'Blocking ticket IDs' -r
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update; and __pa_core_completing_option_value --blocked-by' -a '(__pa_core_ticket_ids)'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l doc-ref -d 'Add doc reference' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l doc-ref-primary -d 'Make doc-ref primary'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l remove-doc-ref -d 'Remove doc reference' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l linked-branch -d 'Link branch repo|branch|sha' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l linked-commit -d 'Link commit repo|sha|message|author|timestamp' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l remove-linked-branch -d 'Remove linked branch' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l remove-linked-commit -d 'Remove linked commit' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l force -d 'Suppress doc-ref warnings'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from attach' -l file -d 'File or doc-ref path' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from comment' -l author -d 'Comment author' -r -a '(__pa_core_assignees)'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from comment' -l content -d 'Comment content' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from comment' -l content-file -d 'Content from file' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from move check-refs' -l project -d 'Target project' -r -a '(__pa_core_projects)'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from delete' -l force -d 'Hard delete'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from delete' -l yes -d 'Confirm hard delete'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket; and not __fish_seen_subcommand_from create update complete list' -a 'create update complete list'
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create' -l title -d 'Subticket title' -r
complete -c pa-core -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create' -l assignee -d 'Assignee' -r -a '(__pa_core_assignees)'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create' -l priority -d 'Priority' -r -a 'critical high medium low'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create' -l estimate -d 'Estimate' -r -a 'XS S M L XL'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create update complete list' -a '(__pa_core_ticket_ids)'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket update' -a '(__pa_core_ticket_ids)'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket complete' -a '(__pa_core_ticket_ids)'
complete -c pa-core -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket list' -a '(__pa_core_ticket_ids)'

complete -c pa-core -n '__fish_seen_subcommand_from bulletin; and not __fish_seen_subcommand_from list create resolve' -a 'list create resolve'
complete -c pa-core -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from resolve' -a '(__pa_core_bulletin_ids)' -d 'Bulletin ID'
complete -c pa-core -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from create' -l title -d 'Title' -r
complete -c pa-core -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from create' -l block -d 'Block target' -r -a 'all (__pa_core_teams)'
complete -c pa-core -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from create' -l except -d 'Excluded teams' -r -a '(__pa_core_teams)'
complete -c pa-core -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from create' -l message -d 'Message' -r

complete -c pa-core -n '__fish_seen_subcommand_from health' -l json -d 'Output JSON'
complete -c pa-core -n '__fish_seen_subcommand_from health' -l save -d 'Save snapshot'
complete -c pa-core -n '__fish_seen_subcommand_from health' -l primer-summary -d 'Compact primer summary'
complete -c pa-core -n '__fish_seen_subcommand_from health' -l history -d 'Show health snapshot history'
complete -c pa-core -n '__fish_seen_subcommand_from health' -l days -d 'Window days' -r
complete -c pa-core -n '__fish_seen_subcommand_from health' -l since -d 'Window since date' -r

complete -c pa-core -n '__fish_seen_subcommand_from trash; and not __fish_seen_subcommand_from list move show restore purge' -a 'list move show restore purge'
complete -c pa-core -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from show restore' -a '(__pa_core_trash_ids)' -d 'Trash ID'
complete -c pa-core -f -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from list' -l status -d 'Status' -r -a 'trashed restored purged'
complete -c pa-core -f -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from list move' -l type -d 'File type' -r -a 'skill team objective mode other'
complete -c pa-core -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from list' -l search -d 'Search text' -r
complete -c pa-core -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from move' -l reason -d 'Reason' -r
complete -c pa-core -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from move' -l actor -d 'Actor' -r
complete -c pa-core -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from move' -l yes -d 'Confirm trash move'
complete -c pa-core -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from restore' -l force -d 'Overwrite existing destination'
complete -c pa-core -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from purge' -l days -d 'Minimum age days' -r
complete -c pa-core -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from purge' -l dry-run -d 'Preview purge'

complete -c pa-core -n '__fish_seen_subcommand_from codectx; and not __fish_seen_subcommand_from analyze refresh summary status query exists' -a 'analyze refresh summary status query exists'
complete -c pa-core -n '__fish_seen_subcommand_from codectx; and __fish_seen_subcommand_from query' -a 'exports file function fn class' -d 'Query type'

complete -c pa-core -n '__fish_seen_subcommand_from signal; and not __fish_seen_subcommand_from collect' -a collect -d 'Collect Note to Self messages'
complete -c pa-core -n '__fish_seen_subcommand_from signal; and __fish_seen_subcommand_from collect' -l dry-run -d 'Preview without writing'
complete -c pa-core -n '__fish_seen_subcommand_from signal; and __fish_seen_subcommand_from collect' -l skip-route -d 'Extract raw notes only'
complete -c pa-core -n '__fish_seen_subcommand_from signal; and __fish_seen_subcommand_from collect' -l reprocess -d 'Re-route existing raw notes'
complete -c pa-core -n '__fish_seen_subcommand_from signal; and __fish_seen_subcommand_from collect' -l conversation-id -d 'Override conversation ID' -r
