# Local-source content security — PAP-292 follow-up

User correction after d-09f8df: every content-security decision needs trusted
source metadata plus content. For local sources, apply sensitive/security file
rules before allowing access; matching readable content is redacted before
presentation. This is not a public-web policy reversal or an approval grant.

## Contract

- Native implementations, not model JSON or text inside a document, determine
  source: local-file (actual path), local-tool-output (trusted tool), or the native
  public-web response. A caller cannot label a local file as remote to escape checks.
- Local source admission checks existing shared protected paths and configured
  filename/path rules on both logical and resolved paths. A blocked file stays
  blocked even if its text looks harmless. Redaction does not grant file access.
- Allowed local text is scanned with built-in and selected local content rules.
  Matching lines become `[REDACTED local sensitive content]`. Unmatched ordinary
  context stays readable. Private-key headers also suppress their body/footer or
  unterminated tail. Scan complete file text BEFORE read pagination; do not expose
  unscanned tails merely because a header was on an earlier page.
- Ordinary projections retain line count when possible. Text is not original
  bytes after redaction; do not treat its hash as the source digest or execute it
  as an approved input. Source/input/package/decision validators keep their
  existing rejection behavior and real bytes; do not redact an approval subject
  into a different silently accepted document.
- Matchers include configured patterns. Malformed/unavailable policy fails closed.
  Full local scans are bounded to 16MiB UTF-8. File reads use the existing Linux
  descriptor-pinned regular/single-link file reader; unsupported aliases, changing
  files and oversized sources fail closed. Excess matches/output are withheld,
  not a claim that an unscanned file is safe. These are explicit security limits.
- The native public reader's existing inbound public-text allowance remains;
  supplied/redirect URL checks still precede network work. A source label inside
  local content or tool input is never the native public reader's authority.
- No matched values, snippets, hashes of credentials or new raw-secret audit sink.
  Historical transcripts/audits are NOT rewritten. Prior exposure still needs
  credential-owner review; a new binary cannot retract old model context.

## Engineering slices

S1: pa-core source/content check, local source admission and redaction projections.
The existing assignment detector also recognizes a quoted JSON key; its prior
expression missed the closing quote before `:`. This narrows unsafe input acceptance
without replacing input-validator owners. Tests use inert canaries only.

S2: Pi integration must enforce this before local tool results/updates reach model,
TUI or runtime result capture. Preserve native capability guards and direct/nested
routes. Pure result transformation is separate from effect admission: a withheld
reply is never proof that an operation did not happen. Public results are exempt
only through their trusted native implementation, never a caller `source` field.

S3: reconcile source inventory, focused safety/composition/legacy tests, build and
typecheck. Record separate installed qualification, public-reader regression,
independent review and human UAT gaps. Commit each slice; do not install or mutate
active deployments/configuration to validate it.

This is managed-agent security, NOT a hostile same-UID filesystem sandbox or a
promise to identify every possible credential/encoding/image. In particular, shell
can generate/transform arbitrary bytes and native private evidence has its owning
policy; supported local projections must not be advertised as universal host data
loss prevention. Non-text attachments need their actual media-specific owner, not
an invented text/OCR pass.

## Implemented checkpoints and test label

- S1 `2e85a11`: trusted source/content projection and local admission primitive;
  quoted JSON assignment detection; inert source/path/regex/boundary fixtures.
- S2 `52e5194`: secured ordinary Pi read/bash implementations plus shared custom
  registration/result guards. No new capability IDs or native mutation actions.
- S3 candidate label **0.1.161-pap292.1**, across the four shared manifests.
  Source CLI `node packages/pi-pa/dist/cli.js --version` returned that exact label.
  The installed system PPA still returned 0.1.161 when checked; it was not changed.

The real Pi definitions still own read pagination/images and shell formatting/exit
handling. Read checks complete text before applying offsets; matching private-key
blocks cannot escape by requesting a later body line. Bash buffers stdout/stderr
before Pi can stream, truncate or write its automatic spill. Live shell text and
custom-tool partial content are delayed/suppressed until checked final delivery.
The 16MiB shell capture cap discards additional text but retains actual process
settlement/exit behavior; withholding output never means the command did not run.
Original source files, native state and authority evidence are not edited.

Registered custom tools also filter final content, structured content and renderer
`details` (including edit diffs) on direct calls. The `tool_result` hook covers
normal/nested built-in delivery. Malformed policy returns a fixed bounded withheld
result instead of throwing from the hook and allowing Pi to continue with raw
content. Trusted native public-reader content carries an in-memory custody mark;
model JSON/source strings cannot mint it. URL checks and public-response allowance
remain with the actual public reader. All unknown/local shell output is local for
content filtering, not an authenticated remote exemption.

Security overrides register read/bash replacements, NOT new role permissions.
Policy tools retain immutable selection checks; retained document profiles deny
shell through both tool_call and direct registered replacement execution. Retained
intake's bounded late-call contract remains unchanged. No second authority ledger,
raw-secret audit sink, config selection or migration was introduced. Shared path
classification now includes local sensitive filename/path rules for recognized
shell operands and aliases; ordinary prose is still not a path operand.

This does not prove the provenance of arbitrary shell-computed fragments, encodings
or images, or prevent a same-UID process from deliberately writing/exfiltrating
bytes. Only content matching the actual rules can be redacted. Direct CLI use
outside the managed Pi tool pipeline is not newly claimed to be output-filtered;
OPA has shared path-gate regression coverage, not new Pi-equivalent output hooks.

## Actual source validation

All fixtures are inert/disposable. No real credentials were read to test the fix,
no d-09f8df logs were copied/rewritten, and no installed deployment was migrated.

| Lane | Actual result / temporary log |
| --- | --- |
| corepack pnpm typecheck | PASS, /tmp/pap292-security-typecheck.log |
| corepack pnpm build | PASS, /tmp/pap292-security-build.log |
| Core source/sensitive/safety/public-content/reader/transport/mode-capabilities/catalogue/discovery | 72/72 PASS, no skips, /tmp/pap292-security-core-final.log |
| Pi local-source/parity/policy/web-launch/composition/native-host/document-native/intake/adapter | 113/113 PASS, no skips, /tmp/pap292-security-pi-final.log |
| Document package/service/integrity/confirmation, Pi document/session/confirmation, ticket status native/core, OPA adapter | 154 PASS, zero failed, 1 existing external data-analysis fixture SKIP, /tmp/pap292-security-owners-final.log |
| PAPC requirements-capabilities and guided-requirements composition with explicit runtime root | 50/50 PASS, no skips, /tmp/pap292-security-papc-final.log |
| corepack pnpm completions | PASS, no tracked diff |
| staged secrets scan / git diff --check | Repeated before final commit; no real secrets in fixtures |

Exact source commands use `node --import=tsx --test` with the listed files under
`packages/*/src/__tests__`. Core files: source-content-security, sensitive-patterns,
safety-policy, public-web-content-source, public-web-reader, public-web-transport,
mode-capabilities, interactions-catalogue, interactions-discovery. Pi files:
local-source-security, requirements-tool-parity, mode-capability-session,
public-web-launch, pi-extension-composition, pi-native-host, document-native,
interactions-ticket-native, pi-adapter. Owner lane: core document-package,
document-service, document-integrity, document-confirmation, ticket-status;
Pi document-session, document-confirmation-native, document-confirmation-entry,
ticket-status-native; OPA opencode-adapter. PAPC uses `node --test` on
scripts/requirements-capabilities.test.mjs and scripts/guided-requirements.test.mjs.

The local-source suite includes real Pi read/bash execution, full-file private-key
offset protection, configured blocked aliases, split UTF-8/secret shell chunks,
actual Pi truncation spill verified free of the inert canary, nonzero exit retention,
cap/invalid-policy behavior, JSON/structured/diff redaction, spoofed public origins,
direct calls, safe custom updates and actual ExtensionRunner result replacement.
No source result is an installed foreground or human acceptance observation.

Preserved development failures: initial TypeScript annotations/generic smoke-map
capture needed correction; composition snapshots initially did not include secured
read/bash replacements; a retained native-session/late-intake failure contract
changed during wrapper development and was restored while keeping direct shell
admission denied. First integration run: 48 pass/4 fail; final expanded Pi lane
113/113 pass. Initial staged scan rejected inline inert credential-shaped canary
literals; tests now assemble explicitly fake data, and the real scanner is retained.

The source-only inventory was renewed only after semantic reconciliation: no new
CLI forms/aliases/effect classifications; registry help now names secured ordinary
owners, shared path/content checks are stricter, public custody is native, and
retained mutation/effect owners are unchanged. Four existing tracked hashes were
renewed and seven relevant source/guard/smoke files added to coverage. Hashes are
change detection, not independent security approval.

PAPC HEAD remained 8deb96c. A new external `config.yaml` modification was observed
alongside pre-existing sample.html during final validation; neither file was edited,
staged or reverted by repository edit operations here. Its origin is unverified;
PAPC composition results are not a clean immutable full-config qualification.

## Messages, incident and remaining evidence

Before: ordinary local read could expose a matching value in the model/TUI/session;
Pi diagnostics' historical pass-through/shadow audit was not prevention. After:
matching local lines show `[REDACTED local sensitive content]` and a projection
notice; protected sources remain denied; uncheckable output is withheld.
For example, synthetic `ordinary\napi_key = <inert long canary>\nordinary end`
becomes ordinary context, a redacted line and ordinary end. The underlying file
stays unchanged. JSON-shaped native output preserves safe fields where possible,
never treating the projection as authority. Pure fixed SourceContentSecurityError
messages use one five-label envelope under 2000 UTF-16 units, no raw path/pattern/
matched value and no formatting probes. Unknown effects retain original operation
coordinates and require owner inspection, not blind replay. Structural propagation
and real-tool tests pass; independent human readability review is NOT RUN.

The d-09f8df report's confidentiality failure and unversioned installed provenance
remain historical failures/limitations. A new source build cannot retract prior
transcripts, private audits or model exposure; credential-owner review is still
needed. Do not share raw logs. No rotation/revocation or deletion was performed.

At the S3 checkpoint, full workspace regression had NOT been rerun, and the updated
installed trial/hosted CI/independent review/human UAT were outstanding. Those
historical limits do not become passes merely because source changed.

## Subsequent installed smoke and integration

The operator installed the labelled candidate; the agent monitored that existing
installation and ran fresh automated foreground requirements/analyze **d-2bdb5d**.
PPA reported **0.1.161-pap292.1**, Pi 1.4.0; nine key installed modules matched the
compiled worktree. Native binding selected PAPC 8deb96c, no rogue-one/fallback.
The report records nine bounded PASS and two BLOCKED. Inert ordinary read and
shell-output canaries were redacted with safe surrounding context; an in-file
public-source claim granted no exemption. A fake-key body-only read was redacted
before pagination and an absent protected .env path was denied. Original inert
file digests/lengths were unchanged. No real credential-bearing source was read.
Synthetic PAP-295 remains cancelled with history retained.

Managed provenance reading was unavailable; separately observed metadata says
unversioned-dirty-source. Exact source remains unverified. Native decision-read
coverage had no real subject; workflow listing succeeded. The operator set aside
provenance as a blocker for the bounded smoke and requested integration, not a
fabricated PASS or human UAT receipt. Native registry status remains partial
(no staged completion payload), despite normal CLI exit. The earlier exposure
still needs separate credential-owner review.

See [validation disposition](PAP-292-validation.md#installed-follow-up-and-integration-disposition)
for private evidence paths/digests and remaining limits. Integration restores the
plain develop version 0.1.161 without changing the installed trial, config pin or
dependencies. No full PAP-292 closure, universal DLP, independent review or human
acceptance is implied. Never retest by reading the previously exposed credential.
