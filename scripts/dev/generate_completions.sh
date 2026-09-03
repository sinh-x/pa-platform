#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PA_CORE="$ROOT/completions/pa-core.fish"
OPA="$ROOT/completions/opa.fish"
CPA="$ROOT/completions/cpa.fish"

if [[ ! -f "$PA_CORE" ]]; then
  echo "Missing source completions: $PA_CORE" >&2
  exit 1
fi

perl \
  -e '
    local $/;
    $_ = <>;
    s/Fish completions for pa-core/Fish completions for opa (opencode-pa adapter)/;
    s/__pa_core_/__opa_/g;
    s/\bpa-core\b/opa/g;
    s/case --mode --objective --evaluate-deployment --repo --ticket --timeout/case --mode --objective --objective-file --evaluate-deployment --provider --model --team-model --repo --ticket --timeout --resume/;
    s/--mode --objective --evaluate-deployment --background --dry-run --repo --ticket --timeout/--mode --objective --objective-file --evaluate-deployment --list-modes --validate --provider --model --team-model --background --dry-run --repo --ticket --timeout --resume/;
    s/complete -c opa -f -n __opa_deploy_completing -l provider -d '\''Provider'\'' -r/complete -c opa -f -n __opa_deploy_completing -l provider -d '\''Provider'\'' -r -a '\''opencode-go minimax openai deepseek ollama-cloud'\''/;
    s/complete -c opa -f -n __opa_deploy_completing -l (?:model|team-model) -d '\''(?:Model|Deprecated model alias \(PAP-147\))'\'' -r/$& -a '\''(__opa_models_for_provider)'\''/g;
    s/(complete -c opa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r\n)/complete -c opa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r -a '\''minimax openai deepseek ollama-cloud'\''\n/;
    print;
  ' \
  "$PA_CORE" > "$OPA"

echo "Generated completions/opa.fish from completions/pa-core.fish"

perl \
  -e '
    local $/;
    $_ = <>;
    s/Fish completions for pa-core/Fish completions for cpa (claudecode-pa adapter)/;
    s/__pa_core_/__cpa_/g;
    s/\bpa-core\b/cpa/g;
    s/case --mode --objective --evaluate-deployment --repo --ticket --timeout/case --mode --objective --objective-file --evaluate-deployment --provider --model --team-model --repo --ticket --timeout --resume/;
    s/--mode --objective --evaluate-deployment --background --dry-run --repo --ticket --timeout/--mode --objective --objective-file --evaluate-deployment --list-modes --validate --provider --model --team-model --background --dry-run --repo --ticket --timeout --resume/;
    s/complete -c cpa -f -n __cpa_deploy_completing -l provider -d '\''Provider'\'' -r/complete -c cpa -f -n __cpa_deploy_completing -l provider -d '\''Provider'\'' -r -a '\''anthropic'\''/;
    s/complete -c cpa -f -n __cpa_deploy_completing -l (?:model|team-model) -d '\''(?:Model|Deprecated model alias \(PAP-147\))'\'' -r/$& -a '\''claude-opus-4-7 claude-sonnet-4-6 claude-haiku-4-5'\''/g;
    s/(complete -c cpa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r\n)/complete -c cpa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r -a '\''anthropic'\''\n/;
    print;
  ' \
  "$PA_CORE" > "$CPA"

echo "Generated completions/cpa.fish from completions/pa-core.fish"

DPA="$ROOT/completions/dpa.fish"

perl \
  -e '
    local $/;
    $_ = <>;
    s/Fish completions for pa-core/Fish completions for dpa (droidcode-pa adapter)/;
    s/__pa_core_/__dpa_/g;
    s/\bpa-core\b/dpa/g;
    s/case --mode --objective --evaluate-deployment --repo --ticket --timeout/case --mode --objective --objective-file --evaluate-deployment --provider --model --team-model --repo --ticket --timeout --resume/;
    s/--mode --objective --evaluate-deployment --background --dry-run --repo --ticket --timeout/--mode --objective --objective-file --evaluate-deployment --list-modes --validate --provider --model --team-model --background --dry-run --repo --ticket --timeout --resume/;
    s/complete -c dpa -f -n __dpa_deploy_completing -l provider -d '\''Provider'\'' -r/complete -c dpa -f -n __dpa_deploy_completing -l provider -d '\''Provider'\'' -r -a '\''openai deepseek gemini minimax anthropic'\''/;
    s/complete -c dpa -f -n __dpa_deploy_completing -l (?:model|team-model) -d '\''(?:Model|Deprecated model alias \(PAP-147\))'\'' -r/$& -a '\''(__dpa_models_for_provider)'\''/g;
    s/(complete -c dpa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r\n)/complete -c dpa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r -a '\''openai deepseek gemini minimax anthropic'\''\n/;
    print;
  ' \
  "$PA_CORE" > "$DPA"

echo "Generated completions/dpa.fish from completions/pa-core.fish"

PPA="$ROOT/completions/ppa.fish"

perl \
  -e '
    local $/;
    $_ = <>;
    s/Fish completions for pa-core/Fish completions for ppa (pi-pa adapter)/;
    s/__pa_core_/__ppa_/g;
    s/\bpa-core\b/ppa/g;
    s/case --mode --objective --evaluate-deployment --repo --ticket --timeout/case --mode --objective --objective-file --evaluate-deployment --provider --model --team-model --repo --ticket --timeout --resume/;
    s/--mode --objective --evaluate-deployment --background --dry-run --repo --ticket --timeout/--mode --objective --objective-file --evaluate-deployment --list-modes --validate --provider --model --team-model --background --dry-run --repo --ticket --timeout --resume/;
    s/complete -c ppa -f -n __ppa_deploy_completing -l provider -d '\''Provider'\'' -r/complete -c ppa -f -n __ppa_deploy_completing -l provider -d '\''Pi provider override (openai\/openai-codex)'\'' -r -a '\''openai openai-codex'\''/;
    s/complete -c ppa -f -n __ppa_deploy_completing -l (?:model|team-model) -d '\''(?:Model|Deprecated model alias \(PAP-147\))'\'' -r/$& -a '\''gpt-5.6-sol openai\/gpt-5.6-sol'\''/g;
     s/(complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r\n)/$1/;
     s/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Provider'\'' -r/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l provider -d '\''Pi provider (openai\/openai-codex)'\'' -r -a '\''openai openai-codex'\''/;
     s/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l model -d '\''Model'\'' -r/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l model -d '\''Pi model (default gpt-5.6-sol)'\'' -r -a '\''gpt-5.6-sol openai\/gpt-5.6-sol'\''/;
     s/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l team-model -d '\''Team model'\'' -r/complete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l team-model -d '\''Deprecated model alias (PAP-147)'\'' -r -a '\''gpt-5.6-sol openai\/gpt-5.6-sol'\''/;
     s/\ncomplete -c ppa -f -n '\''__fish_seen_subcommand_from evaluate'\'' -l agent-model -d '\''Agent model'\'' -r//;
     s/(complete -c ppa -n __fish_use_subcommand -a signal -d '\''Collect Signal Note to Self messages'\''\n)/$1complete -c ppa -n __fish_use_subcommand -a pi -d '\''Manage Pi package registration'\''\ncomplete -c ppa -n '\''__fish_seen_subcommand_from pi; and not __fish_seen_subcommand_from setup status remove'\'' -a '\''setup status remove'\''\ncomplete -c ppa -n '\''__fish_seen_subcommand_from pi; and __fish_seen_subcommand_from setup status remove'\'' -l local -d '\''Use project-local .pi settings'\''\n/;
     print;
  ' \
  "$PA_CORE" > "$PPA"

echo "Generated completions/ppa.fish from completions/pa-core.fish"
