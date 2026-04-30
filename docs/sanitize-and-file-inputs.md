# Sanitization And File Input Policy

> Date: 2026-04-30
> Status: current-state documentation and recommended policy
> Scope: `pa-core` CLI/API validation, OpenCode adapter redaction, ticket file inputs, doc refs, and Signal sensitive routing.

This document records the current sanitization and file-input behavior in `pa-platform`, then defines the recommended policy for future changes. The goal is to protect model prompts, logs, API file reads, and workflow state without adding unnecessary friction to trusted local CLI workflows.

## Summary

`pa-platform` currently uses several targeted safety mechanisms instead of one shared sanitization layer:

- Deploy request validation rejects malformed deploy fields before execution.
- Agent API document/folder/image routes sandbox user-provided paths to `~/Documents/ai-usage`.
- Activity and OpenCode stream summaries redact common secret indicators and truncate output.
- Signal note routing classifies obvious sensitive text before normal workflow routing.
- Local CLI file inputs such as `opa deploy --objective-file` and `opa ticket comment --content-file` are trusted local convenience inputs: their paths are not sandboxed before reading.

The main policy gap is not whether `--objective-file` should exist. It should. The gap is that files whose contents become model-visible prompt content should have clear guardrails for obvious sensitive files and secret-like content.

## Current Deploy Workflow

`opa deploy` is split between shared `pa-core` command parsing and the OpenCode adapter runtime hook.

1. `packages/pa-core/src/cli/core-command.ts` parses `opa deploy` arguments.
2. If `--objective-file <path>` is passed, the CLI reads `readFileSync(resolve(value), "utf-8")` immediately.
3. The file contents become the deploy `objective` field.
4. `packages/pa-core/src/deploy/control.ts` validates the deploy request fields.
5. `packages/opencode-pa/src/deploy.ts` generates the OpenCode primer and writes it to `~/Documents/ai-usage/deployments/<deploy-id>/primer.md`.
6. The OpenCode adapter launches or resumes the runtime using that primer.

For API deploys, `packages/pa-core/src/agent-api/routes/deploy-control.ts` accepts JSON request bodies and runs the same deploy request validation. The API does not accept an `objectiveFile` field, so remote API callers cannot ask the server to read an arbitrary objective file through deploy control.

## Existing Checks

| Area | Location | Current behavior |
|---|---|---|
| Deploy field validation | `packages/pa-core/src/deploy/control.ts` | Validates `team`, `mode`, `repo`, `ticket`, provider/model names, `resume`, `timeout`, and objective content. |
| Objective content validation | `packages/pa-core/src/deploy/control.ts` | Rejects objectives over 10000 characters and rejects control characters plus `` ` $ \\ ; & \| > < ``. |
| Objective file path handling | `packages/pa-core/src/cli/core-command.ts` | Resolves and reads the path directly; no path sandbox is applied. |
| Ticket comment file input | `packages/pa-core/src/cli/commands/ticket.ts` | `--content-file` resolves and reads the path directly; no path sandbox is applied. |
| Agent API path sandbox | `packages/pa-core/src/agent-api/utils/sandbox.ts` | Ensures API document/folder/image paths resolve inside `~/Documents/ai-usage`. |
| API documents/images | `packages/pa-core/src/agent-api/routes/documents.ts` | Reads only after sandbox validation. |
| Activity summaries | `packages/pa-core/src/activity/index.ts` | Masks token/secret/password/key indicators, bearer tokens, `sk-*`, sensitive file paths, and truncates event bodies. |
| OpenCode stream summaries | `packages/opencode-pa/src/adapter.ts` | Masks secret-looking stream text and truncates stream bodies. |
| Signal sensitive routing | `packages/pa-core/src/signal/sensitive.ts` | Detects seed phrases, SSH public keys, bot-token-like values, and `sgnl://` links as sensitive. |
| Ticket doc refs | `packages/pa-core/src/tickets/doc-ref.ts` | Resolves relative paths under `~/Documents/ai-usage`; absolute paths and URLs are allowed as stored references. |

## Trust Boundaries

Different inputs need different rules because they have different trust boundaries.

| Boundary | Examples | Recommended posture |
|---|---|---|
| Local trusted CLI input | `--objective-file`, `--content-file` | Allow local files, but block obvious sensitive paths/content when the contents enter model-visible prompts or persisted workflow comments. |
| Remote/API path input | `/api/documents?path=...`, `/api/images?path=...` | Require sandbox validation before file reads. |
| Model-visible prompt content | deploy objectives, generated primers, injected memory docs, mode objectives | Validate size/characters and block or warn on likely secrets. |
| Logs/activity/registry summaries | activity JSONL, OpenCode stream summaries, registry events | Always redact and truncate. |
| Persistent references | ticket `doc_refs` | Prefer ai-usage-relative paths; support URLs explicitly; avoid absolute local paths unless there is a deliberate reason. |

## Recommended Policy

The recommended policy is permissive for trusted local CLI use and strict for remote/API reads.

| Input type | Policy |
|---|---|
| `opa deploy --objective-file` | Keep allowed. It is a useful local workflow for multi-line objectives and should not be repo-only or ai-usage-only by default. |
| `opa ticket comment --content-file` | Keep allowed, with the same local-trusted posture. |
| API path inputs | Keep strict sandboxing to `~/Documents/ai-usage`; do not allow arbitrary absolute file reads through API routes. |
| Model-visible file contents | Add guardrails against obvious secret files and obvious secret content before sending to a model. |
| Activity and stream summaries | Continue redacting and truncating; keep these checks independent from deploy validation. |
| Doc refs | Encourage relative ai-usage paths in docs and examples; treat absolute paths as local references that may not be readable through API document routes. |

## Recommended Guardrails For CLI File Inputs

For local file inputs whose contents may enter model context or persistent workflow state, prefer guardrails over hard sandboxing.

Guardrails should reject obviously sensitive file paths before reading when feasible:

- `.env`, `.env.*`
- `.npmrc`, `.pypirc`, `.netrc`
- `.ssh/id_*`
- `credentials*.json`
- `secret*.json`, `secrets*.yaml`, `secrets*.yml`
- `*token*.json`
- `*api-key*.json`, `*api_key*.json`

Guardrails should reject or require explicit confirmation for obvious sensitive content after reading:

- Seed phrases.
- SSH private or public key material.
- Bearer tokens.
- `sk-*` style provider keys.
- Bot/API token patterns already covered by Signal sensitive routing.

Non-interactive `opa` commands should fail closed with a clear error instead of prompting for confirmation. If a bypass is ever needed, add an explicit flag such as `--allow-sensitive-file` rather than weakening the default.

## Why Not Sandbox `--objective-file` By Default

`--objective-file` is a local operator command, not a remote file-read API. Sandboxing it to the repo or `~/Documents/ai-usage` would prevent legitimate low-friction workflows such as drafting an objective in `/tmp`, another project checkout, or a notes directory and passing it directly to `opa deploy`.

The better tradeoff is:

- Keep local file convenience.
- Block known-dangerous filenames and content patterns.
- Clearly document that objective file contents are sent into the generated primer and may be visible to the model runtime.
- Keep remote/API file reads sandboxed.

## Known Gaps

| Gap | Risk | Recommended action |
|---|---|---|
| `--objective-file` has no sensitive path/content check | A local operator can accidentally pass a credentials file into a model-visible primer. | Add a shared helper for safe local content-file reads used by deploy objective files. |
| `--content-file` has no sensitive path/content check | A sensitive file can be persisted into ticket comments. | Reuse the same helper for ticket comment file reads. |
| Objective validation is content-shape focused, not secret focused | Secret-looking strings may pass if they avoid rejected characters. | Add sensitive-content detection before accepting objective text from file or inline objective. |
| Doc refs can store absolute local paths | CLI can record references that the API document route will not serve because of sandboxing. | Prefer docs/examples that use ai-usage-relative doc refs; optionally warn on absolute non-URL doc refs. |
| Redaction patterns are duplicated | Activity and OpenCode stream redaction use similar but separate pattern lists. | Consider a shared redaction utility if patterns diverge or more sinks are added. |

## Implementation Notes For Future Work

Future implementation should keep the change small:

- Add one shared helper in `pa-core` for reading trusted local text inputs with sensitive path/content checks.
- Use it for `--objective-file` and `--content-file` first.
- Keep API sandboxing unchanged.
- Keep activity/stream redaction unchanged unless adding a shared utility is part of the same scoped task.
- Add tests for allowed normal files and rejected sensitive-looking files.

Suggested acceptance checks for a future implementation:

- `opa deploy <team> --objective-file objective.md --dry-run` accepts a normal objective file.
- `opa deploy <team> --objective-file .env --dry-run` fails with a clear sensitive-file error.
- `opa ticket comment <id> --content-file note.md --author builder/team-manager` accepts a normal comment file.
- `opa ticket comment <id> --content-file credentials.json --author builder/team-manager` fails with a clear sensitive-file error.
- Agent API document routes continue to reject paths outside `~/Documents/ai-usage`.
