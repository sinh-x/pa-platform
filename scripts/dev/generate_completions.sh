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
    s/__pa_core_/__opa_/g;
    s/\bpa-core\b/opa/g;
    s/case --mode --objective --repo --ticket --timeout/case --mode --objective --objective-file --provider --model --team-model --agent-model --repo --ticket --timeout --resume/;
    s/--mode --objective --background --dry-run --repo --ticket --timeout/--mode --objective --objective-file --list-modes --validate --provider --model --team-model --agent-model --background --dry-run --repo --ticket --timeout --resume/;
    s/(complete -c opa -n __opa_deploy_completing -l objective -d '\''Deployment objective'\'' -r\n)/$1complete -c opa -n __opa_deploy_completing -l objective-file -d '\''Objective from file'\'' -r -a '\''(complete -C "echo " | string match -r "^[^ ]+")'\''\ncomplete -c opa -n __opa_deploy_completing -l list-modes -d '\''List available deploy modes'\''\ncomplete -c opa -n __opa_deploy_completing -l validate -d '\''Validate without deploying'\''\ncomplete -c opa -f -n __opa_deploy_completing -l provider -d '\''Provider'\'' -r -a '\''openai minimax'\''\ncomplete -c opa -f -n __opa_deploy_completing -l model -d '\''Model'\'' -r -a '\''gpt-5.5 MiniMax-M2.7 openai\/gpt-5.5 minimax-coding-plan\/MiniMax-M2.7'\''\ncomplete -c opa -f -n __opa_deploy_completing -l team-model -d '\''Team model'\'' -r -a '\''gpt-5.5 MiniMax-M2.7 openai\/gpt-5.5 minimax-coding-plan\/MiniMax-M2.7'\''\ncomplete -c opa -f -n __opa_deploy_completing -l agent-model -d '\''Agent model'\'' -r -a '\''gpt-5.5 MiniMax-M2.7 openai\/gpt-5.5 minimax-coding-plan\/MiniMax-M2.7'\''\n/;
    s/(complete -c opa -n __opa_deploy_completing -l timeout -d '\''Timeout seconds'\'' -r\n)/$1complete -c opa -f -n __opa_deploy_completing -l resume -d '\''Resume from deployment ID'\'' -r -a '\''(__opa_deployments)'\''\n/;
    print;
  ' \
  "$PA_CORE" > "$OPA"

echo "Generated completions/opa.fish from completions/pa-core.fish"
