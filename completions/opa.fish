# Fish completions for opa (opencode-pa adapter)

function __opa_teams
    if command -q opa
        opa teams 2>/dev/null | awk 'NR>1 && NF>0 && $1 != "TEAM" && $1 !~ /^-+$/ {print $1}'
        return
    end

    set -l dirs
    if set -q PA_PLATFORM_TEAMS; and test -d "$PA_PLATFORM_TEAMS"
        set -a dirs "$PA_PLATFORM_TEAMS"
    end
    if set -q PA_PLATFORM_HOME; and test -d "$PA_PLATFORM_HOME/teams"
        set -a dirs "$PA_PLATFORM_HOME/teams"
    end
    if test -d ~/.config/sinh-x/pa-platform/teams
        set -a dirs ~/.config/sinh-x/pa-platform/teams
    end
    for dir in $dirs
        for file in $dir/*.yaml
            if test -f "$file"
                basename "$file" .yaml
            end
        end
    end | sort -u
end

function __opa_modes
    set -l cmdline (string split ' ' (commandline -p))
    set -l team_name ""
    set -l found_deploy false
    for token in $cmdline
        if $found_deploy
            if not string match -q -- '-*' $token
                set team_name $token
                break
            end
        end
        if test "$token" = deploy
            set found_deploy true
        end
    end
    test -z "$team_name"; and return

    if command -q opa
        set -l modes (opa deploy "$team_name" --list-modes 2>/dev/null | awk 'NR>1 && $1 != "" {id=$1; $1=""; sub(/^[[:space:]]+/, ""); print id "\t" $0}')
        if test (count $modes) -gt 0
            printf '%s\n' $modes
            return
        end
    end

    set -l candidates
    if set -q PA_PLATFORM_TEAMS
        set -a candidates "$PA_PLATFORM_TEAMS/$team_name.yaml"
    end
    if set -q PA_PLATFORM_HOME
        set -a candidates "$PA_PLATFORM_HOME/teams/$team_name.yaml"
    end
    set -a candidates ~/.config/sinh-x/pa-platform/teams/$team_name.yaml

    for file in $candidates
        if test -f "$file"
            string match -r '^\s+- id:\s*(.+)' < "$file" | string replace -r '^\s+- id:\s*' ''
            return
        end
    end
end

function __opa_projects
    opa repos list 2>/dev/null | awk 'NR>2 && NF>0 {print $1}'
end

function __opa_deployments
    command -q opa; or return

    opa registry list --limit 100 2>/dev/null | awk 'NR>2 && $1 ~ /^d-/ {
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

function __opa_ticket_ids
    command -q opa; or return

    opa ticket list 2>/dev/null | awk '/^[A-Z][A-Z0-9]*-[0-9]+[[:space:]]/ {
        id = $1;
        $1 = $2 = $3 = $4 = "";
        sub(/^[[:space:]]+/, "");
        if ($0 == "") $0 = "Ticket";
        print id "\t" $0;
    }'
end

function __opa_bulletin_ids
    opa bulletin list 2>/dev/null | string match -rg 'B-[0-9]+'
end

function __opa_trash_ids
    opa trash list 2>/dev/null | string match -rg '^T-[0-9]+'
end

function __opa_timer_names
    systemctl --user list-timers 'pa-*' --no-legend 2>/dev/null | string match -r 'pa-\S+\.timer' | string replace -r '^pa-' '' | string replace -r '\.timer$' '' | sort -u
end

function __opa_assignees
    printf '%s\n' (__opa_teams) sinh builder/team-manager | sort -u
end

complete -c opa -f

complete -c opa -n __fish_use_subcommand -a repos -d 'Manage repositories'
complete -c opa -n __fish_use_subcommand -a status -d 'Show deployment status'
complete -c opa -n __fish_use_subcommand -a deploy -d 'Deploy an agent team'
complete -c opa -n __fish_use_subcommand -a serve -d 'Start API server through adapter hook'
complete -c opa -n __fish_use_subcommand -a stop -d 'Stop API server through adapter hook'
complete -c opa -n __fish_use_subcommand -a restart -d 'Restart API server through adapter hook'
complete -c opa -n __fish_use_subcommand -a serve-status -d 'Show API server status through adapter hook'
complete -c opa -n '__fish_seen_subcommand_from serve; and not __fish_seen_subcommand_from stop restart status' -a 'stop restart status' -d 'Serve action'
complete -c opa -n __fish_use_subcommand -a schedule -d 'Schedule a systemd timer'
complete -c opa -n __fish_use_subcommand -a timers -d 'List PA systemd timers'
complete -c opa -n __fish_use_subcommand -a remove-timer -d 'Remove a systemd timer'
complete -c opa -n __fish_use_subcommand -a board -d 'Show kanban board'
complete -c opa -n __fish_use_subcommand -a teams -d 'List teams'
complete -c opa -n __fish_use_subcommand -a registry -d 'Manage deployment registry'
complete -c opa -n __fish_use_subcommand -a ticket -d 'Manage tickets'
complete -c opa -n __fish_use_subcommand -a bulletin -d 'Manage bulletins'
complete -c opa -n __fish_use_subcommand -a health -d 'Generate health report'
complete -c opa -n __fish_use_subcommand -a trash -d 'Manage trash'
complete -c opa -n __fish_use_subcommand -a codectx -d 'Analyze and query code context'
complete -c opa -n __fish_use_subcommand -a signal -d 'Collect Signal Note to Self messages'

complete -c opa -n '__fish_seen_subcommand_from repos; and not __fish_seen_subcommand_from list' -a list -d 'List repositories'

complete -c opa -n '__fish_seen_subcommand_from deploy; and not __fish_seen_subcommand_from (__opa_teams)' -a '(__opa_teams)' -d 'Team name'
complete -c opa -f -n '__fish_seen_subcommand_from deploy' -l mode -d 'Deploy mode' -r -a '(__opa_modes)'
complete -c opa -n '__fish_seen_subcommand_from deploy' -l objective -d 'Deployment objective' -r
complete -c opa -n '__fish_seen_subcommand_from deploy' -l objective-file -d 'Objective from file' -r -a '(complete -C "echo " | string match -r "^[^ ]+")'
complete -c opa -n '__fish_seen_subcommand_from deploy' -l list-modes -d 'List available deploy modes'
complete -c opa -n '__fish_seen_subcommand_from deploy' -l validate -d 'Validate without deploying'
complete -c opa -f -n '__fish_seen_subcommand_from deploy' -l provider -d 'Provider' -r -a 'openai minimax'
complete -c opa -f -n '__fish_seen_subcommand_from deploy' -l model -d 'Model' -r -a 'gpt-5.5 MiniMax-M2.7 openai/gpt-5.5 minimax-coding-plan/MiniMax-M2.7'
complete -c opa -f -n '__fish_seen_subcommand_from deploy' -l team-model -d 'Team model' -r -a 'gpt-5.5 MiniMax-M2.7 openai/gpt-5.5 minimax-coding-plan/MiniMax-M2.7'
complete -c opa -f -n '__fish_seen_subcommand_from deploy' -l agent-model -d 'Agent model' -r -a 'gpt-5.5 MiniMax-M2.7 openai/gpt-5.5 minimax-coding-plan/MiniMax-M2.7'
complete -c opa -n '__fish_seen_subcommand_from deploy' -l repo -d 'Repository name' -r -a '(__opa_projects)'
complete -c opa -f -n '__fish_seen_subcommand_from deploy' -l ticket -d 'Ticket ID' -r -a '(__opa_ticket_ids)'
complete -c opa -n '__fish_seen_subcommand_from deploy' -l timeout -d 'Timeout seconds' -r
complete -c opa -n '__fish_seen_subcommand_from deploy' -l resume -d 'Resume from deployment ID' -r -a '(__opa_deployments)'

complete -c opa -n '__fish_seen_subcommand_from status; and not __fish_seen_subcommand_from (__opa_deployments)' -a '(__opa_deployments)' -d 'Deployment'
complete -c opa -n '__fish_seen_subcommand_from status' -l running -d 'Only running deployments'
complete -c opa -n '__fish_seen_subcommand_from status' -l today -d 'Only today deployments'
complete -c opa -n '__fish_seen_subcommand_from status' -l team -d 'Filter by team' -r -a '(__opa_teams)'
complete -c opa -n '__fish_seen_subcommand_from status' -l recent -d 'Limit recent deployments' -r
complete -c opa -n '__fish_seen_subcommand_from status' -l wait -d 'Check whether deployment is terminal'
complete -c opa -n '__fish_seen_subcommand_from status' -l report -d 'Show work report for deployment'
complete -c opa -n '__fish_seen_subcommand_from status' -l artifacts -d 'List deployment artifact files'
complete -c opa -n '__fish_seen_subcommand_from status' -l activity -d 'Show deployment activity timeline'

complete -c opa -n '__fish_seen_subcommand_from schedule; and test (count (commandline -opc)) -eq 2' -a '(__opa_teams) daily:plan daily:progress daily:end signal:collect' -d 'Schedule spec'
complete -c opa -f -n '__fish_seen_subcommand_from schedule; and test (count (commandline -opc)) -eq 3' -a 'hourly daily weekly monthly' -d 'Repeat interval'
complete -c opa -f -n '__fish_seen_subcommand_from schedule' -l repeat -d 'Repeat interval' -r -a 'hourly daily weekly monthly'
complete -c opa -n '__fish_seen_subcommand_from schedule' -l time -d 'Time HH:MM' -r
complete -c opa -n '__fish_seen_subcommand_from schedule' -l command -d 'Command written to systemd unit' -r
complete -c opa -n '__fish_seen_subcommand_from schedule' -l dry-run -d 'Preview systemd units without writing'
complete -c opa -n '__fish_seen_subcommand_from remove-timer' -a '(__opa_timer_names)' -d 'Timer name'
complete -c opa -n '__fish_seen_subcommand_from remove-timer' -l dry-run -d 'Preview removal'
complete -c opa -n '__fish_seen_subcommand_from remove-timer' -l yes -d 'Confirm removal'

complete -c opa -n '__fish_seen_subcommand_from board' -l project -d 'Filter by project' -r -a '(__opa_projects)'
complete -c opa -n '__fish_seen_subcommand_from board' -l assignee -d 'Filter by assignee' -r -a '(__opa_assignees)'
complete -c opa -n '__fish_seen_subcommand_from board' -l all -d 'Accepted for compatibility'

complete -c opa -n '__fish_seen_subcommand_from teams; and not __fish_seen_subcommand_from (__opa_teams)' -a '(__opa_teams)' -d 'Team name'
complete -c opa -n '__fish_seen_subcommand_from teams' -l all -d 'Include backlog and archived tickets'

complete -c opa -n '__fish_seen_subcommand_from registry; and not __fish_seen_subcommand_from list show complete update amend search analytics clean sweep' -a 'list show complete update amend search analytics clean sweep'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from show complete update amend' -a '(__opa_deployments)' -d 'Deployment ID'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from list' -l team -d 'Filter by team' -r -a '(__opa_teams)'
complete -c opa -f -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from list' -l status -d 'Filter by status' -r -a 'running success partial failed crashed dead unknown'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from list' -l since -d 'Filter since date' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from list search' -l limit -d 'Limit results' -r
complete -c opa -f -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l status -d 'Completion status' -r -a 'success partial failed'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update amend' -l summary -d 'Summary text' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update amend' -l log-file -d 'Session log path' -r
complete -c opa -f -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-source -d 'Rating source' -r -a 'agent system user'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-overall -d 'Overall rating 0-5' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-productivity -d 'Productivity rating 0-5' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-quality -d 'Quality rating 0-5' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-efficiency -d 'Efficiency rating 0-5' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete update' -l rating-insight -d 'Insight rating 0-5' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from complete' -l fallback -d 'Fallback completion marker'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from update' -l note -d 'Free-text update note' -r
complete -c opa -f -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from analytics' -l view -d 'Analytics view' -r -a 'daily teams ratings'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from analytics' -l team -d 'Filter by team' -r -a '(__opa_teams)'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from analytics' -l since -d 'Filter since date' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from clean' -l threshold -d 'Orphan threshold hours' -r
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from clean' -l dry-run -d 'Preview only'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from clean' -l mark-dead -d 'Mark orphans as crashed'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from sweep' -l dry-run -d 'Preview only'
complete -c opa -n '__fish_seen_subcommand_from registry; and __fish_seen_subcommand_from sweep' -l fix -d 'Write fallback markers'

complete -c opa -n '__fish_seen_subcommand_from ticket; and not __fish_seen_subcommand_from create update list show attach comment move delete check-refs subticket' -a 'create update list show attach comment move delete check-refs subticket'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from show update attach comment move delete' -a '(__opa_ticket_ids)'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create' -l project -d 'Project' -r -a '(__opa_projects)'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create' -l title -d 'Title' -r
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list' -l type -d 'Ticket type' -r -a 'feature bug task review-request work-report fyi idea question'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list update' -l priority -d 'Priority' -r -a 'critical high medium low'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create update' -l estimate -d 'Estimate' -r -a 'XS S M L XL'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list update' -l assignee -d 'Assignee' -r -a '(__opa_assignees)'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create' -l summary -d 'Summary' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create' -l description -d 'Description' -r
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list update' -l status -d 'Status' -r -a 'idea requirement-review pending-approval pending-implementation implementing review-uat done rejected cancelled'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from create list update' -l tags -d 'Tags' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from list' -l project -d 'Project' -r -a '(__opa_projects)'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from list' -l search -d 'Search text' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from list' -l exclude-tags -d 'Excluded tags' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from show' -l json -d 'Output JSON'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update create comment move delete attach' -l actor -d 'Actor' -r
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l blocked-by -d 'Blocking ticket IDs' -r -a '(__opa_ticket_ids)'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l doc-ref -d 'Add doc reference' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l doc-ref-primary -d 'Make doc-ref primary'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l remove-doc-ref -d 'Remove doc reference' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l linked-branch -d 'Link branch repo|branch|sha' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l linked-commit -d 'Link commit repo|sha|message|author|timestamp' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l remove-linked-branch -d 'Remove linked branch' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l remove-linked-commit -d 'Remove linked commit' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from update' -l force -d 'Suppress doc-ref warnings'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from attach' -l file -d 'File or doc-ref path' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from comment' -l author -d 'Comment author' -r -a '(__opa_assignees)'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from comment' -l content -d 'Comment content' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from comment' -l content-file -d 'Content from file' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from move check-refs' -l project -d 'Target project' -r -a '(__opa_projects)'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from delete' -l force -d 'Hard delete'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from delete' -l yes -d 'Confirm hard delete'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket; and not __fish_seen_subcommand_from create update complete list' -a 'create update complete list'
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create' -l title -d 'Subticket title' -r
complete -c opa -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create' -l assignee -d 'Assignee' -r -a '(__opa_assignees)'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create' -l priority -d 'Priority' -r -a 'critical high medium low'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create' -l estimate -d 'Estimate' -r -a 'XS S M L XL'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket create update complete list' -a '(__opa_ticket_ids)'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket update' -a '(__opa_ticket_ids)'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket complete' -a '(__opa_ticket_ids)'
complete -c opa -f -n '__fish_seen_subcommand_from ticket; and __fish_seen_subcommand_from subticket list' -a '(__opa_ticket_ids)'

complete -c opa -n '__fish_seen_subcommand_from bulletin; and not __fish_seen_subcommand_from list create resolve' -a 'list create resolve'
complete -c opa -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from resolve' -a '(__opa_bulletin_ids)' -d 'Bulletin ID'
complete -c opa -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from create' -l title -d 'Title' -r
complete -c opa -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from create' -l block -d 'Block target' -r -a 'all (__opa_teams)'
complete -c opa -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from create' -l except -d 'Excluded teams' -r -a '(__opa_teams)'
complete -c opa -n '__fish_seen_subcommand_from bulletin; and __fish_seen_subcommand_from create' -l message -d 'Message' -r

complete -c opa -n '__fish_seen_subcommand_from health' -l json -d 'Output JSON'
complete -c opa -n '__fish_seen_subcommand_from health' -l save -d 'Save snapshot'
complete -c opa -n '__fish_seen_subcommand_from health' -l primer-summary -d 'Compact primer summary'
complete -c opa -n '__fish_seen_subcommand_from health' -l history -d 'Show health snapshot history'
complete -c opa -n '__fish_seen_subcommand_from health' -l days -d 'Window days' -r
complete -c opa -n '__fish_seen_subcommand_from health' -l since -d 'Window since date' -r

complete -c opa -n '__fish_seen_subcommand_from trash; and not __fish_seen_subcommand_from list move show restore purge' -a 'list move show restore purge'
complete -c opa -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from show restore' -a '(__opa_trash_ids)' -d 'Trash ID'
complete -c opa -f -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from list' -l status -d 'Status' -r -a 'trashed restored purged'
complete -c opa -f -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from list move' -l type -d 'File type' -r -a 'skill team objective mode other'
complete -c opa -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from list' -l search -d 'Search text' -r
complete -c opa -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from move' -l reason -d 'Reason' -r
complete -c opa -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from move' -l actor -d 'Actor' -r
complete -c opa -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from move' -l yes -d 'Confirm trash move'
complete -c opa -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from restore' -l force -d 'Overwrite existing destination'
complete -c opa -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from purge' -l days -d 'Minimum age days' -r
complete -c opa -n '__fish_seen_subcommand_from trash; and __fish_seen_subcommand_from purge' -l dry-run -d 'Preview purge'

complete -c opa -n '__fish_seen_subcommand_from codectx; and not __fish_seen_subcommand_from analyze refresh summary status query exists' -a 'analyze refresh summary status query exists'
complete -c opa -n '__fish_seen_subcommand_from codectx; and __fish_seen_subcommand_from query' -a 'exports file function fn class' -d 'Query type'

complete -c opa -n '__fish_seen_subcommand_from signal; and not __fish_seen_subcommand_from collect' -a collect -d 'Collect Note to Self messages'
complete -c opa -n '__fish_seen_subcommand_from signal; and __fish_seen_subcommand_from collect' -l dry-run -d 'Preview without writing'
complete -c opa -n '__fish_seen_subcommand_from signal; and __fish_seen_subcommand_from collect' -l skip-route -d 'Extract raw notes only'
complete -c opa -n '__fish_seen_subcommand_from signal; and __fish_seen_subcommand_from collect' -l reprocess -d 'Re-route existing raw notes'
complete -c opa -n '__fish_seen_subcommand_from signal; and __fish_seen_subcommand_from collect' -l conversation-id -d 'Override conversation ID' -r
