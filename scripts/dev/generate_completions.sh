#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PA_CORE="$ROOT/completions/pa-core.fish"
OPA="$ROOT/completions/opa.fish"

if [[ ! -f "$PA_CORE" ]]; then
  echo "Missing source completions: $PA_CORE" >&2
  exit 1
fi

perl \
  -e '
    local $/;
    $_ = <>;
    s/Fish completions for pa-core/Fish completions for opa (opencode-pa adapter)/;
    s/\n# PPA_ONLY_DEPLOY_OPTION ticket-worktree//;
    s/__pa_core_/__opa_/g;
    s/\bpa-core\b/opa/g;
    s/Registered key or primary path; PPA omission may infer authenticated linked-worktree CWD/Registered repository key or exact configured path/;
    s/case --mode --objective --evaluate-deployment --repo --ticket --timeout/case --mode --objective --objective-file --evaluate-deployment --provider --model --team-model --repo --ticket --timeout --resume/;
    s/--mode --objective --evaluate-deployment --background --dry-run --repo --ticket --timeout/--mode --objective --objective-file --evaluate-deployment --list-modes --validate --provider --model --team-model --background --dry-run --repo --ticket --timeout --resume/;
    s/complete -c opa -f -n __opa_deploy_completing -l provider -d '\''Provider'\'' -r/complete -c opa -f -n __opa_deploy_completing -l provider -d '\''Provider'\'' -r -a '\''opencode-go minimax openai deepseek ollama-cloud'\''/;
    s/complete -c opa -f -n __opa_deploy_completing -l (?:model|team-model) -d '\''(?:Model|Deprecated model alias \(PAP-147\))'\'' -r/$& -a '\''(__opa_models_for_provider)'\''/g;
    s/(complete -c opa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r\n)/complete -c opa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r -a '\''minimax openai deepseek ollama-cloud'\''\n/;
    print;
  ' \
  "$PA_CORE" > "$OPA"

echo "Generated completions/opa.fish from completions/pa-core.fish"

PPA="$ROOT/completions/ppa.fish"

perl \
  -e '
    local $/;
    $_ = <>;
    s/Fish completions for pa-core/Fish completions for ppa (pi-pa adapter)/;
    s/# PPA_ONLY_DEPLOY_OPTION ticket-worktree/complete -c ppa -n __ppa_deploy_completing -l ticket-worktree -d '\''Select existing ticket worktree (non-builder; --ticket required)'\''/;
    s/__pa_core_/__ppa_/g;
    s/\bpa-core\b/ppa/g;
    s/Link branch repo\|branch\|sha/Plan or authenticate branch repo|branch/;
    s/case --mode --objective --evaluate-deployment --repo --ticket --timeout/case --mode --objective --objective-file --evaluate-deployment --provider --model --team-model --repo --ticket --timeout --resume/;
    s/--mode --objective --evaluate-deployment --background --dry-run --repo --ticket --timeout/--mode --objective --objective-file --evaluate-deployment --list-modes --validate --provider --model --team-model --background --dry-run --repo --ticket --timeout --resume/;
    s/complete -c ppa -f -n __ppa_deploy_completing -l provider -d '\''Provider'\'' -r/complete -c ppa -f -n __ppa_deploy_completing -l provider -d '\''Pi provider override (openai\/openai-codex)'\'' -r -a '\''openai openai-codex'\''/;
    s/complete -c ppa -f -n __ppa_deploy_completing -l (?:model|team-model) -d '\''(?:Model|Deprecated model alias \(PAP-147\))'\'' -r/$& -a '\''gpt-6.1-sol openai\/gpt-6.1-sol'\''/g;
     s/(complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r\n)/$1/;
     s/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Pi provider (openai\/openai-codex)'\'' -r -a '\''openai openai-codex'\''/;
     s/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l model -d '\''Model'\'' -r/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l model -d '\''Pi model (default gpt-6.1-sol)'\'' -r -a '\''gpt-6.1-sol openai\/gpt-6.1-sol'\''/;
     s/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l team-model -d '\''Team model'\'' -r/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l team-model -d '\''Deprecated model alias (PAP-147)'\'' -r -a '\''gpt-6.1-sol openai\/gpt-6.1-sol'\''/;
     s/\ncomplete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l agent-model -d '\''Agent model'\'' -r//;
     s/(complete -c ppa -n __fish_use_subcommand -a signal -d '\''Collect Signal Note to Self messages'\''\n)/$1complete -c ppa -n __fish_use_subcommand -a pi -d '\''Manage Pi package registration'\''\ncomplete -c ppa -n '\''__fish_seen_subcommand_from pi; and not __fish_seen_subcommand_from setup status remove'\'' -a '\''setup status remove'\''\ncomplete -c ppa -n '\''__fish_seen_subcommand_from pi; and __fish_seen_subcommand_from setup status remove'\'' -l local -d '\''Use project-local .pi settings'\''\n/;
     print;
  ' \
  "$PA_CORE" > "$PPA"

printf '%s\n' \
  '' \
  '# Pi-only observational protected-review contract preflight' \
  "complete -c ppa -n __fish_use_subcommand -a review -d 'Protected review preflight'" \
  "complete -c ppa -n '__fish_seen_subcommand_from review; and not __fish_seen_subcommand_from artifact; and not __fish_seen_subcommand_from preflight' -a preflight -d 'Static checks only; grants no authority'" \
  "complete -c ppa -n '__fish_seen_subcommand_from review; and not __fish_seen_subcommand_from artifact; and __fish_seen_subcommand_from preflight' -l ticket -r -d 'Exact ticket ID'" \
  "complete -c ppa -n '__fish_seen_subcommand_from review; and not __fish_seen_subcommand_from artifact; and __fish_seen_subcommand_from preflight' -l objective-file -r -d 'Versioned JSON objective file'" \
  "complete -c ppa -n '__fish_seen_subcommand_from review; and not __fish_seen_subcommand_from artifact; and __fish_seen_subcommand_from preflight' -l json -d 'JSON report'" \
  >> "$PPA"
printf '%s\n' \
  '' \
  '# Pi-only terminal child reconciliation; apply uses native in-session dispatch' \
  "complete -c ppa -n '__fish_seen_subcommand_from pi; and not __fish_seen_subcommand_from setup status remove preflight smoke-tools teardown-smoke reconcile-child' -a reconcile-child -d 'Inspect retained terminal child facts'" \
  "complete -c ppa -n '__fish_seen_subcommand_from pi; and __fish_seen_subcommand_from reconcile-child' -l parent-id -r -d 'Exact parent deployment ID'" \
  "complete -c ppa -n '__fish_seen_subcommand_from pi; and __fish_seen_subcommand_from reconcile-child' -l child-id -r -d 'Exact direct child deployment ID'" \
  "complete -c ppa -n '__fish_seen_subcommand_from pi; and __fish_seen_subcommand_from reconcile-child' -l ticket -r -d 'Exact ticket ID'" \
  "complete -c ppa -n '__fish_seen_subcommand_from pi; and __fish_seen_subcommand_from reconcile-child' -l apply -d 'Native foreground confirmation required; no shell apply'" \
  "complete -c ppa -n '__fish_seen_subcommand_from pi; and __fish_seen_subcommand_from reconcile-child' -l json -d 'Versioned redacted result'" \
  >> "$PPA"
printf '%s\n' \
  '' \
  '# Pi/PPA-only canonical template drafts; no output writer' \
  "complete -c ppa -n __fish_use_subcommand -a template -d 'Selected canonical template drafts'" \
  "complete -c ppa -n '__fish_seen_subcommand_from template; and not __fish_seen_subcommand_from list show render validate' -a 'list show render validate'" \
  "complete -c ppa -n '__fish_seen_subcommand_from template' -l version -r -d 'Exact selected template revision'" \
  "complete -c ppa -n '__fish_seen_subcommand_from template' -l format -r -a 'json markdown'" \
  >> "$PPA"
printf '%s\n' \
  '' \
  '# Pi-only JSON workflow reads; decisions are written only by authenticated native dialogs' \
  "complete -c ppa -n __fish_use_subcommand -a 'workflow decision' -d 'Structured workflow read surfaces'" \
  "complete -c ppa -n '__fish_seen_subcommand_from workflow; and not __fish_seen_subcommand_from list show validate preflight status next' -a 'list show validate preflight status next'" \
  "complete -c ppa -n '__fish_seen_subcommand_from decision; and not __fish_seen_subcommand_from show verify' -a 'show verify'" \
  "complete -c ppa -n '__fish_seen_subcommand_from workflow decision' -l ticket -r -d 'Exact ticket ID'" \
  "complete -c ppa -n '__fish_seen_subcommand_from workflow decision' -l id -r -d 'Exact workflow or decision ID'" \
  "complete -c ppa -n '__fish_seen_subcommand_from workflow; and __fish_seen_subcommand_from validate' -l definition-file -r -d 'Bounded local JSON for static inspection only'" \
  "complete -c ppa -n '__fish_seen_subcommand_from workflow decision' -l json -d 'Stable JSON projection'" \
  >> "$PPA"
echo "Generated completions/ppa.fish from completions/pa-core.fish"
