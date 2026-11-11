# Config-owned Pi document capabilities (PAP-289)

Status: config-selected reader **enabled in source for qualification**, not installed
or qualified by this change. Current `.4` inbound-content policy and machine
source labels are defined in [public-web-source-policy.md](public-web-source-policy.md).
See [current enablement and packaging](#current-enablement-and-packaging--d-b08f19)
for the policy decision and remaining delivery steps. Historical checkpoints below
retain their original staged/closed-gate status; they do not describe this candidate.
Audience: runtime/PAPC maintainers and independent reviewers. Product authority is
PAP-289's published `pap-289-config-capabilities/r006` requirements and UAT package.
This page documents the source contract, not a replacement approval or matrix.

## Selection and compatibility

Only a fresh foreground, unpinned, non-resumed Pi `requirements/analyze` start can
select `document_profile: pa-document-policy/v1`. It requires `capability_policy`
with exactly `version: pa-mode-capabilities/v1` and `allow: [...]`. Selection is
replacement, not additive; `[]` grants no model-selectable tools. Native lifecycle
and operator commands are not model tool grants. No other role/adapter migrates.
Present invalid policies reject; retained absent-policy v1/v2/v3/v4 routes keep
their old contracts. The policy route preserves v4 package/workspace and finite
intake semantics only for explicitly selected tools; it does not relabel a policy
caller as v4 or upgrade an existing session. OPA rejects this Pi-only selection rather than ignoring it.

The launcher reads committed `teams/requirements.yaml` using
`CommittedConfigSource`, requires the loaded mode and committed selection to
agree, and rechecks source drift before native start and again after hooks/preflight,
immediately before runtime spawn. A preflight drift failure uses the existing
terminal owner: preparation may have started, but Pi is not spawned. The immutable execution plan
and registry `started.mode_capability_binding` record config revision, raw resource
SHA-256, path, profile, policy version and canonical sorted selected IDs. The new
native start marker is `requirements-document-policy/v1`. Neither an environment
claim nor possession of serialized binding data authenticates a caller.

On every invocation, the existing document owner authenticates live registry,
canonical root, process incarnation/lineage and session. The immutable binding must
match the status projection and canonical serialization. Tool exposure and exact
execution selection use the same resolver. `tool_call` guards built-ins and nested
SDK calls; custom `execute` wrappers also guard direct calls. Aliases/namespaces do
not grant access. Config edits/reload do not replace native launch selection.
This is not hostile-same-UID isolation. Existing path, secret, workspace, native
confirmation/publication/queue, custody and cleanup checks remain authoritative.

## Closed inventory

All IDs below support only the new policy profile. The registry describes trusted
in-package implementations; it supplies **no default role selection**. Existing
TypeBox schemas and native action parsers remain request/result owners; config
cannot replace them with paths, modules, commands, headers or authority fields.

| ID | Exact tool | Action/schema and intrinsic owner |
| --- | --- | --- |
| `document.package` | `pa_document` | `document-native.ts`; v4-compatible package grammar and unchanged native confirmation owner |
| `document.workspace` | `pa_workspace` | `document-workspace.ts`; bounded workspace grammar; no network |
| `ticket.read-comment` | `pa_ticket` | `ticket-tool.ts`; read/show/list/comment and ticket owner |
| `ticket.intake` | `pa_ticket_intake` | `ticket-intake-tool.ts`, `interactions/tickets.ts`; capabilities/inspect/reuse/create/patch-planning under existing ticket intent/CAS and retained-owner checks |
| `capability.discover` | `pa_capabilities` | `capability-tool.ts`; bounded source-only list/describe, never live availability or execution authority |
| `bulletin.read` | `pa_bulletin` | list active bulletins |
| `registry.read` | `pa_registry` | show/list bounded registry data |
| `status.read` | `pa_status` | one deployment status |
| `template.draft` | `pa_template` | list/show/render/validate, unsigned selected-template owner |
| `human.question` | `question` | human question; never native protected approval |
| `session.todo` | `todo` | session-local task lifecycle |
| `context.read` | `read` | existing canonical project/artifact/config path and content guards |
| `web.public-read` | `pa_web_read` | `public-web/reader.ts` + `web-read-tool.ts`; supplied-public-HTTPS reader, selected only through the immutable native policy |

A configuration preserving the current v4 baseline explicitly lists all twelve
non-web IDs. The original ten-ID example omitted v4 intake and source discovery;
PAPC-081 correctly rejected it as a migration baseline. For example (synthetic,
not an instruction to edit active config):

```yaml
- id: analyze
  document_profile: pa-document-policy/v1
  capability_policy:
    version: pa-mode-capabilities/v1
    allow: [document.package, document.workspace, ticket.read-comment, ticket.intake,
            capability.discover, bulletin.read, registry.read, status.read,
            template.draft, human.question, session.todo, context.read]
```

Unknown/duplicate IDs, wildcards, tool-name aliases, null/wrong/extra fields,
unsupported profiles/versions, duplicate YAML keys and merge-key inheritance reject.
The selected resource is at most 64 KiB UTF-8; policies have at most 64 unique IDs,
each at most 128 ASCII characters. The finite current registry is smaller than the
upper bound: a 64-element array of unknown IDs still rejects. New IDs require a
runtime implementation, not a config override.

### V4 compatibility and PAPC handoff

PAP-289's original base `1eaf2e3f4f871cf0eaa2dbc07c969589f864978b`
predated PAP-282. Sinh authorized local integration of exact develop
`b7476b607187de081d95ccb8bc9e4bddd620652f`, which contains the native v4
implementation. This candidate combines both dispatches, rather than copying an
unimplemented ID or rebuilding the ticket effect owner. PAPC-081 accepted the
corrected source contract in `c-20261110141005340`; integration/source agreement
is not installed qualification or adoption.

`ticket.intake` and `capability.discover` are independent selectors: neither
implies the other, `ticket.read-comment`, a package tool, or a writer. The intake
interface reports the actual policy native profile plus `requiredCapability`;
retained v4 interface metadata and request/result semantics are unchanged. The
core ticket service checks the selected binding again inside existing creation
and planning mutexes. Identity-bound snapshot versions, original request IDs and
payloads, CAS, retained deployment exclusions and primary association all retain
their existing owners. No cross-profile replay or authority translation is added.
Late custom calls are rejected by the lifecycle before guard authentication can
reopen a closed registry. The primer now names the policy profile and exact set,
not the v1 fallback prose; matching PAPC process instructions remain PAPC-owned.

Concrete synthetic example: a policy selecting only `ticket.intake` may use its
strict native interface to create one explicitly requested companion to an
already-bound primary. Replaying the same request ID/content returns that same
ticket; changing the title conflicts. Inspect/reuse do not claim/reassociate it.
Planning uses both original inspected versions and only the permitted scalar
fields. Omit `ticket.intake` and even a direct implementation call rejects before
constructing a ticket store; selecting source discovery does not restore intake.
This demonstrates a contract, not actual companion creation or human UAT.

Paired focused entrypoints (run from the indicated package with
`corepack pnpm --filter PACKAGE exec tsx --test --test-concurrency=1`):

- `@pa-platform/pa-core`: `src/__tests__/mode-capabilities.test.ts` for strict
  selection/primer; `src/__tests__/interactions-ticket.test.ts` runs service
  scenarios under both v4 and policy callers, including original-intent recovery,
  changed caller/binding, CAS and retained-owner negatives.
- `@pa-platform/pi-pa` after the core build:
  `src/__tests__/mode-capability-session.test.ts` covers selected/omitted intake,
  real native owner with synthetic host, full intake/companion/inspect/reuse/
  planning/replay, discovery, immutable registration and late-call rejection.
  `src/__tests__/interactions-ticket-native.test.ts` retains v4 controls and adds
  a real source launcher/committed-config selection fixture for the policy route.
  These are disposable source fixtures, not installed foreground qualification.

The integrated PAP-282 conservative source-inventory check initially rejected
changed ticket dispatch bytes. Semantic reconciliation found the same finite
intake actions, aliases, read/write classifications and effect owners; eligibility
now also includes explicitly selected policy callers. Catalogue owner descriptions
reflect that distinction without populating live binding/authority fields. The
nine affected source hashes were renewed, and policy registry/resolver plus the
generic execution guard were added to snapshot coverage. This is change detection,
not independent semantic completeness or installed provenance.

## Config-selected public-page reader

The source composition now registers `pa_web_read` only when the immutable policy
selects it. Its strict request is `{ "url": "https://…" }`; config cannot supply
headers, a connector, an extractor, credentials or execution authority. The Pi
implementation authenticates the original deployment/session and selected ID again
on every direct call, in addition to the generic execution/hook guards. This is a
new implementation: the reported rogue-one operation remains unobserved, so no
transport-reuse or installed-parity claim is made.

`packages/pa-core/src/public-web/` owns these runtime-neutral components:

- `policy.ts`: raw/canonical URL checks before normalization can hide obfuscated
  addresses; native sensitive input checks; conservative public IPv4/IPv6 unicast.
  Special-use/transition ranges and reserved/intranet hostnames are excluded.
- `transport.ts`: cancellable system DNS A/AAAA queries, all-answer validation in
  the reader, direct TLS to one pinned public answer, original-host certificate and
  actual-peer checks **before** creating the HTTP GET. A fresh non-pooled agent
  uses only that verified socket; ambient HTTP proxies/global agents are not used.
  Fixed headers carry no cookies, authorization, referrer or transcript. No retry.
- `extract.ts`: bounded static HTML/UTF-8 plain-text extraction, not browser
  rendering. Active element contents, comments, forms and control sequences are
  omitted; common login/challenge markers and unsupported/unfinished extraction
  reject. It is deliberately conservative, not universal paywall/injection
  detection or a full HTML DOM. Non-UTF-8, PDF, binary and script-only resources
  are unsupported; access controls are never bypassed. Suppression does not end
  at a non-void HTML element's trailing slash or a whitespace-obfuscated pseudo
  end tag. Nested active/raw-text elements retain their suppressed parent, so an
  apparent parent end tag in script/style/fallback text does not end that parent’s
  suppression.
  Ambiguous foreign self-closing markup and unclosed suppressed containers may
  reject conservatively; this remains a bounded extractor, not a browser parser.
- `reader.ts`: up to five safe redirects, revalidating URL/DNS at every hop;
  4096-byte raw **and encoded** URL ceilings, 30-second deadline checkpoints and
  cancellation across DNS/TLS/body/extraction, independent 2-MiB compressed/decoded
  limits (identity/gzip/deflate/Brotli), 16000 Unicode code points, 2000 text lines
  and 50-KiB serialized tool reply including JSON escaping. HTTP error/redirect
  bodies are not interpreted. Oversized or incomplete bodies fail rather than
  becoming a complete-page claim; output clipping is explicitly reported.

Successful results include safe requested/final URLs, UTC time, optional title,
`bodySha256` of the **complete decoded response bytes**, `textSha256` of the **exact
returned UTF-8 text**, byte/code-point/redirect coverage and a native tool-result
locator `pi-tool-result:<deployment>/<toolCallId>`. The exact provider tool-call ID
may include the OpenAI Responses composite separator `|` and a nested `/<n>`
suffix. It remains bounded inert data, never a filesystem path, shell argument or
web URL. This locator identifies the existing transcript result, not a new
persistent cache or an external artifact.
The coverage kind is always `static-text-not-rendered`; source markup, hidden
content or a clipped suffix is not claimed visible in the returned text.

Synthetic example (not a live request): a supplied page with the sentence “The
value is 42” yields that extracted sentence and the source URL. A redirect to
`127.0.0.1` is rejected before a second connection. A stalled close produces
`WEB_CLEANUP`, not success; subsequent session reads stay blocked.

The native session resource owner permits at most two reads, aborts/waits on
shutdown, and survives same-process reload. A settled reload may reuse it; an
uncertain result cannot be cleared by reload or a session switch. Exact installed
replacement-process/host shutdown behavior still requires separate qualification.
The work deadline is 29 seconds, reserving a bounded one-second socket settlement
wait inside the 30-second total budget; unproven closure is explicit, never
inferred from cancellation. Deadline fixtures are not a measured
installed wall-clock SLA under host scheduling or synchronous extraction load.

### Privacy and activation status

Direct DNS/HTTPS discloses hostname/path/query to the applicable DNS/network and
destination operators. The original supplied input and returned text remain in
the existing model transcript/retention domain. Native sensitive checks still block
sensitive supplied/redirect URLs before admitting them. Following the operator's
explicit `.4` source-policy selection, public response text/title are allowed even
when they match local secret-content heuristics; local file/path/content protection
is unchanged. This is not a claim that credential-looking public content is harmless.
Checks cannot retroactively erase an already supplied user prompt or detect every
possible secret. No new web cache, raw-body audit,
external extraction service or separate retention sink is introduced. Public GET
can cause remote side effects: the tool instructs agents not to read known action
URLs and does not pretend to prove that a URL was selected by a human.

The unconditional launcher `CAPABILITY_UNAVAILABLE` staging rejection is removed
in this candidate following the operator's routing/retention decision below.
Selecting `web.public-read` in an eligible new committed policy now permits native
reader registration and execution; it does **not** send a request at launch or
select it implicitly. Omission continues to deny the tool, including direct calls.
No environment bypass, reader-specific role allowlist, relaxed safety check or
second policy/approval ledger is introduced. Retained sessions do not gain access.

Source registration and synthetic starts are not installed qualification.
Qualification must still measure deadlines, shutdown/reload/replacement and
same-runtime config toggles; independent review, required CI and genuine human
UAT/adoption remain separate. No active PAPC policy, external source, installation
or live network request is changed/performed by this source work.

## Verification and rollout boundaries

Focused source tests: `public-web-reader.test.ts`, `public-web-transport.test.ts`,
`mode-capabilities.test.ts`,
`mode-capability-session.test.ts`, registry/plan/team and retained document tests.
They use disposable native registries/process evidence and synthetic tool/UI seams.
V4 intake, discovery and ticket intent suites additionally cover the integrated
baseline; none is permission to run product ticket effects outside its native owner.
`public-web-launch.test.ts` additionally exercises the real source launcher with
committed disposable configurations, full twelve-ID baseline, reader on/off/on,
exact revision/resource digest/native binding, unsafe literal URL rejection before
DNS, omission/direct-call guards, preflight drift and retained v1-v4 starts. It does
not replace the reader's connector or send live requests. These source launches use
a synthetic provider/host, not the installed foreground application.

Reader tests use synthetic DNS/TLS/socket/content fixtures; an in-memory Duplex
also exercises the real Node HTTPS request/response parser without network access.
Cases cover unsafe/mixed answers and redirects, peer/certificate mismatch, fixed
headers/proxy non-use, bodies/decompression/Unicode/output, outbound/error secret
canaries (and explicit public-response allowance),
cancellation, deadline checkpoints, concurrency, unknown cleanup and native on/off
admission. They are not a real DNS/TLS/public request, installed foreground session,
human readability review or UAT.

PAPC's accepted source contract and committed selection/instructions preserve the
complete baseline. Further selected configuration changes remain PAPC-owned.
The same qualified runtime must demonstrate reader-on/off in separately authorized
new starts, without a rebuild. Current sessions must stay unchanged. No active pin,
installation, public-egress activation, remote push/PR or checkout return is
performed by this source change. Independent review, hosted CI, installed tests,
human clarity/usefulness/UAT and explicit adoption remain separate obligations.

Before: the retained document hook described a fixed artifact/ticket tool route;
the initial policy primer incorrectly fell through to “Native profile:
pa-document-package/v1.” After: it says “Native profile: pa-document-policy/v1”
and displays exact selected IDs/tools, including an empty set. Tool help retains
package/confirmation behavior and labels intake/discovery as separate selections.
These are information/help changes, not new protected-effect approvals. Human
readability and installed foreground checks remain outstanding.

Selected-route blockers distinguish malformed/unknown policy, unsupported
profile, unavailable implementation, unproven binding and omitted capability.
They use fixed, plain, bounded five-field guidance from `modeCapabilityDiagnostic`;
formatting performs no probes/effects and never echoes raw config or errors. Existing
retained messages and machine contracts are unchanged. The registry binding fields
are intentional additive machine-contract changes, not wording-only alterations.

Reader messages are returned tool-result paths: invalid input, native
policy unavailable, unsafe target, sensitive URLs, unsupported content, bounds,
HTTP/network failure, cancellation, timeout, busy capacity and unknown cleanup.
`publicWebDiagnostic` is pure fixed typed text with the same five-label/2000-unit
blocker contract, never raw exceptions or URLs. Success and clipping warnings are
ordinary outcome/coverage prose. Before: URL selection stopped at the unavailable
launch gate. After: an eligible selected policy reaches native registration; a read
returns source text/provenance or an existing typed bounded blocker. New launcher
fixtures observe unsafe-target/omission/binding blockers, not a live page. Message
wording, machine result schemas, streams and exit contracts are unchanged; the
changed path is admission, not a wording-only change. Structural message tests are
not independent human readability review.

## Current enablement and packaging — d-b08f19

PAPC-081's latest feedback (`c-20261110151652796`) correctly reports that its
accepted twelve-ID configuration at `95a2bb593a18ef2f8fbbbf337227cb1bf0d1a53e`
cannot qualify reader-on while the installed runtime unconditionally rejects it.
This source continuation removed that blocker; it did not change that installed
artifact or the companion checkout. At that checkpoint PAPC's committed baseline
still omitted the reader. Later PAPC activation and the actual native reader trial
are recorded in the qualification follow-up below.

In this deployment the operator selected **Accept policy; implement enablement**
after reviewing direct system DNS + HTTPS, network/destination disclosure of
hostname/path/query, existing model-transcript retention of supplied input/returned
text, and no new cache/service. The explicit scope is source enablement and
qualification preparation, **not installation, live requests or completed UAT**.
This conversational decision is not a fabricated native package/approval receipt,
independent security review or final adoption. Existing native effect owners and
reader safety guards remain unchanged. Further routing, storage, proxy or retention
changes need owning review; this decision does not authorize them.

### Clean exact artifact, not a readable-label inference

Do not patch `review-runtime-provenance.json` or substitute the currently installed
`0.1.160-pap289.1` build: its `unversioned-dirty-source` metadata remains historical.
At the operator's follow-up request, the four shared manifests now select
`0.1.160-pap289.2` for the first reader-enabled worktree reference. The
qualification follow-up below advances the source label to `0.1.160-pap289.3`
for provider tool-call ID compatibility. The later source-aware response policy
uses `0.1.160-pap289.4`; see [public-web-source-policy.md](public-web-source-policy.md).
`runtime-host` keeps its independent version. Neither source label changes an existing installation. Compare exact
commits, not labels. After the runtime owner commits the reviewed candidate, use an explicit
full `PAP289_SHA` and physical `PAP289_ROOT` for that clean checkout. Package-only
recipe (not executed here), using the existing release/validation-lane mechanism:

```sh
set -eu
# PAP289_ROOT and PAP289_SHA are supplied by the runtime owner, not inferred
# from a moving feature branch. Commit all candidate edits before this step.
test "$(git -C "$PAP289_ROOT" rev-parse HEAD)" = "$PAP289_SHA"
test -z "$(git -C "$PAP289_ROOT" status --porcelain=v2 --untracked-files=all)"
CANDIDATE_OUTPUT=$(nix build --offline --no-link --no-write-lock-file --print-out-paths \
  "git+file://${PAP289_ROOT}?rev=${PAP289_SHA}#default")
python3 - "$CANDIDATE_OUTPUT" "$PAP289_SHA" "$PAP289_ROOT" <<'PY'
import json, pathlib, re, sys
output, expected, source = sys.argv[1:]
assert re.fullmatch(r'[0-9a-f]{40}', expected), 'Exact full source commit required'
root = pathlib.Path(source)
metadata = json.loads((pathlib.Path(output) / 'share/pa-platform/review-runtime-provenance.json').read_text())
assert metadata['schemaVersion'] == 'pa-review-runtime/v1'
assert metadata['sourceSha'] == expected, 'Dirty/path-derived metadata is not commit provenance'
assert metadata['packageVersion'] == json.loads((root / 'package.json').read_text())['version']
assert metadata['configSha'] == (root / '.pa-platform-config.sha').read_text().strip()
print(json.dumps(metadata, indent=2))
PY
test "$(git -C "$PAP289_ROOT" rev-parse HEAD)" = "$PAP289_SHA"
test -z "$(git -C "$PAP289_ROOT" status --porcelain=v2 --untracked-files=all)"
```

The `git+file` exact revision supplies Nix `self.rev`; a dirty/path flake does not.
Offline cache/toolchain failure is a packaging blocker, not permission to fetch,
install, forge metadata or relabel an old output. The recipe makes no profile or
system selection change. No pin refresh or new trial label is included here.
`configSha` above checks the packaged default pin only, **not** selection of PAPC-081.
A default-pin refresh has its own owner; an explicitly selected clean committed PAPC
configuration must be captured separately by the native capability binding.
See [validation lanes](requirements-validation-lanes.md) for source/installed lane
separation and [release process](release-process.md#ticket-local-build-labels).

### Next PAPC qualification boundary

After exact artifact/provenance verification and separately admitted runtime/config
selection, the PAPC owner can qualify its reader-on/off fixtures with the **same**
installed binary in new normal foreground `requirements/analyze` sessions. Preserve
all twelve baseline IDs and provider/model. Record selected config commit, resource
SHA-256, native binding and runtime store identity for A/B/A; omission must deny
registration and direct execution, and old sessions must not widen. Then use an
operator-supplied public URL/question and observe actual page contents plus citation,
not search snippets or a fabricated retrieval. Do not switch to rogue-one, general
shell or browser to pass. Existing retained/OPA controls, deadlines, cancellation,
shutdown/reload/replacement, independent review, complete required CI and genuine
human readability/UAT/adoption remain separate requirements. None was supplied by
this source-only continuation.

### Qualification follow-up — composite provider tool-call IDs

PAP-289 `c-20261111105014362` records a genuine foreground attempt in
`d-1842c8`: the native policy binding selects the canonical PAPC commit
`c0385c1756c203e7754c3ffc5f895a8712e59149`, resource digest
`11578cebe125e224d66ef39f4b1cc98931cbcba0341c071109201bb99c522eed`,
all twelve baseline IDs plus the reader, and the tool is actually exposed. That
supersedes the earlier missing-tool configuration failure, **not** the remaining
read/qualification requirements. The single read returned `WEB_INPUT`, not-started,
cleanup settled, with no page request or retrieved content.

Read-only inspection of that deployment's original Pi transcript found the
`pa_web_read` arguments were exactly the supplied URL, but the provider-generated
call ID was `call_<id>|fc_<id>`. The pinned Pi AI 0.84.4 Responses adapter constructs
that exact composite shape. Both `web-read-tool.ts`'s ID validator and
`public-web/reader.ts`'s evidence-locator validator rejected `|`. Thus a valid
provider identity was incorrectly reported as bad page input before URL/network
work. The failure was not evidence of GitHub rejection or an unsafe supplied URL.

The `.3` source repair admits **only** that additional separator in both existing
finite character sets; it preserves the exact transcript key without splitting,
replacement, hashing or a new mapping ledger. Existing 200-character call-ID and
256-character locator-suffix bounds remain, as do control/markup rejection and
strict URL-only request shape. Native identity/capability checks still precede
validation, and all URL/DNS/IP/TLS/redirect/credential/content/limit/lifecycle guards
are unchanged. Composite IDs do not become execution targets or authority.

Before: the observed provider ID and valid supplied URL returned `WEB_INPUT` before
network work. After (source fixtures only): the same ID reaches the existing URL
checks; a synthetic public response returns its exact locator, while literal
loopback still returns `WEB_TARGET`, and omission still returns
`CAPABILITY_OMITTED`. Diagnostics and result schemas/streams are unchanged. Human
readability and installed behavior remain separate from structural assertions.

Regression coverage includes the exact observed call ID, nested IDs, boundary
lengths, controls/markup/oversize IDs rejected without connector calls, unchanged
plain IDs/extra-field rejection, and real source-launcher/default tool composition
with a composite ID and an unsafe URL. Initial red runs: core reader 8 passed/1
failed; Pi native/launcher 3 passed/2 failed. Both validators required repair;
accepting the delimiter in only the adapter would still fail in core. Synthetic
fixtures return explicitly synthetic text: no live GitHub request was made.

Actual ordered local checks on `.3` source: `NO_COLOR=1 corepack pnpm build` and
`NO_COLOR=1 corepack pnpm typecheck` passed. Core
`corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1`
with `src/__tests__/{public-web-reader,public-web-transport,mode-capabilities,interactions-catalogue}.test.ts`
passed 26/26; Pi equivalent with
`src/__tests__/{public-web-launch,mode-capability-session,document-session,document-native,document-workspace-dispatch,document-confirmation-native,document-confirmation-entry,interactions-discovery-native,interactions-ticket-native,pi-extension-composition,pi-native-host}.test.ts`
passed 61/61, all with `NO_COLOR=1`, no failures/skips. Logs:
`/tmp/pap289-composite-{core,pi}-final.log`; original red logs:
`/tmp/pap289-composite-{core,pi}-red.log`. Full regression/hosted CI, Nix packaging,
installed execution and human review were not rerun for this repair. Earlier
aggregate/build timeouts remain historical incomplete evidence, not passes.

At that compatibility checkpoint the worktree reference was `0.1.160-pap289.3`
across four shared manifests (superseded by the `.4` source-policy change);
`runtime-host` remains independently versioned. The installed `.2` artifact is not
modified by these edits. Next delivery is a separately built/selected repaired
runtime, then a new normally admitted foreground attempt under the already-recorded
bounded supplied-URL trial scope. Preserve the original denial, do not substitute
shell HTTP, and do not infer success: actual page contents/citation, same-installed-
binary on/off/on, full regressions, independent review and human UAT remain due.
PAPC's recorded trial-only dirty-source exception remains distinct from verified
clean-source provenance and is not reopened by this diagnosis.

### Local source verification for d-b08f19

- Core focused command: `NO_COLOR=1 corepack pnpm --filter @pa-platform/pa-core
  exec tsx --test --test-concurrency=1` with
  `src/__tests__/{public-web-reader,public-web-transport,mode-capabilities,teams,registry,execution-plan,interactions-contract,interactions-catalogue,interactions-discovery,interactions-ticket}.test.ts`:
  **101 passed, zero failed, two existing external-config fixture skips**.
- Pi focused command: `NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa
  exec tsx --test --test-concurrency=1` with
  `src/__tests__/{public-web-launch,mode-capability-session,document-session,document-native,document-workspace-dispatch,document-confirmation-native,document-confirmation-entry,interactions-discovery-native,interactions-ticket-native,pi-extension-composition,pi-native-host}.test.ts`:
  **61 passed, zero failures/skips**, after workspace build/typecheck.
- `NO_COLOR=1 corepack pnpm build` and `NO_COLOR=1 corepack pnpm typecheck`:
  passed. No CLI grammar or completion changes.
- `NO_COLOR=1 timeout --signal=TERM --kill-after=10s 360s corepack pnpm test:code`:
  **incomplete, exit 124**. Root 42/42 passed; the core lane reached reported
  case 1523 without a test failure before interruption, but has no final summary.
  Later package lanes did not run. Log: `/tmp/pap289-d-b08f19-test-code.log`.
  No passing full/code-only aggregate or manual-integration result is claimed.

The new launcher file first reproduced two failures at the closed staging gate.
Removing it left one failing preflight-drift case: the original selection recheck
preceded preflight. The added pre-spawn recheck fixes that case through existing
terminal publication; the test now also verifies the already-recorded native start
and failed completion, with no PID/runtime spawn. Final focused run passes all four
new cases; no assertion was removed to conceal drift.

The dispatch source-inventory digest was renewed only after reconciling the two
launcher changes: finite CLI forms/aliases, launch/resource effect classes,
original intake/CAS owners and source-only discovery availability are unchanged.
Reader selection reaches only the existing native tool, not a generic CLI forwarder;
the new pre-spawn check narrows admission. Catalogue contract/negative/inventory
checks above passed; the hash is change detection, not independent review.
Before/after blocker paths are described above. Plain structural message assertions
passed; independent human readability review and installed behavior were not observed.
After implementation commit `303106e62abbdf1fe9d5e035a42df7328c817bd5`, a
package-only attempt of the exact-Git recipe with a 240-second timeout returned
exit 124, with no output store path published. Nix began the source, provenance and
package derivations, then reported interruption. Logs:
`/tmp/pap289-d-b08f19-package-build.log` and the empty
`/tmp/pap289-d-b08f19-package-output.txt`. This is an **incomplete build**, not
verified artifact provenance. It preceded the `.2` label update; no `.2` Nix artifact
is claimed. Installation and live HTTP remain unperformed.

## Historical source checkpoints

The following records predate d-b08f19. Their closed-gate and outstanding-policy
statements are retained historical facts, superseded for this source candidate by
the current section above, not retroactive changes to installed or test evidence.

### Extraction hardening check — d-34b8ca

Local continuation over `3b3aa4aecbc7fac5b42fe7c660fafc7fc945cbf4`;
implementation and regression tests committed as `b3fa541`:
`extract.ts` and `public-web-reader.test.ts` now cover ignored non-void trailing
slashes, nested hidden containers, whitespace-obfuscated end tags, nested active/
raw-text boundaries, unclosed suppression and ordinary void-element controls.
Before: `<script/>suppressed payload</script><p>Visible article.</p>` returned both
payload and article. After: only `Visible article.` is returned. An apparent
`</div>` inside a hidden container's script likewise no longer ends suppression.
Both defects were reproduced by failing tests before repair. No diagnostic/help
wording, result schema, admission, network transport or launch gate changed.

Actual local checks (not installed qualification):

- `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1`
  with `src/__tests__/{public-web-reader,public-web-transport,mode-capabilities}.test.ts`:
  20 passed, zero failures/skips, with `NO_COLOR=1`.
- `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1`
  with `src/__tests__/{mode-capability-session,document-session,document-native,document-workspace-dispatch,document-confirmation-native,document-confirmation-entry,interactions-discovery-native,interactions-ticket-native,pi-extension-composition}.test.ts`:
  36 passed, zero failures/skips, with `NO_COLOR=1`, after the workspace build.
- `corepack pnpm build`, `corepack pnpm typecheck`, `git diff --check`: passed.
- `NO_COLOR=1 corepack pnpm test`: incomplete at the 600-second command limit.
  Completed root tests: 42 passed; core: 1924 passed/14 skipped; OpenCode:
  106 passed/1 skipped; Pi script tests: 11 passed. No reported failure before
  interruption; this is **not** a passing full-suite result. Local temporary log:
  `/tmp/pap289-d-34b8ca-test.log`.
- Separate `NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa test`:
  incomplete at 360 seconds, no reported failure before interruption; local
  temporary log `/tmp/pap289-d-34b8ca-pi-test.log`.
- `NO_COLOR=1 corepack pnpm --filter @pa-platform/runtime-host test`:
  one passed, zero failures/skips.

No real URL request, installation, PAPC edit, activation, independent review,
hosted CI or human UAT/readability observation was performed. Public-egress/
retention approval and matched PAPC qualification remain outstanding. At that
hardening checkpoint, the updated-develop rebase and ticket-local build label were
still due; the upstream `0.1.160` manifests were unchanged by the extraction fix.

Published r006 phase disposition at this checkpoint (not acceptance):

| Phase | Status |
| --- | --- |
| P1 Contract | Runtime candidate and corrected v4 baseline supplied; PAPC/native-owner agreement remains outstanding. |
| P2 Core | Runtime policy/parser/registry/binding/enforcement source implemented and source-tested. |
| P3 Reader/composition | Runtime reader/native composition implemented but staged; PAPC policy/instructions/privacy composition and installed same-runtime toggle remain outstanding. |
| P4 Qualification | Incomplete: independent review, complete validation/CI, exact installed foreground journey, human readability/UAT and adoption remain unproven. |

Thus the runtime source work is implemented, but **not all ticket phases are complete**
and the public reader is not enabled.

### Worktree identification label

At the operator's subsequent request, the four shared version manifests now select
`0.1.160-pap289.1` for a separately installed worktree trial. `ppa --version` should
then display `ppa 0.1.160-pap289.1`. Build from the clean exact label commit and
verify both `packageVersion` and that commit's `sourceSha` in the installed
`share/pa-platform/review-runtime-provenance.json`; see
[release-process.md](release-process.md#ticket-local-build-labels). This is not an
installation, activation, release/tag or phase-completion claim. The requested
updated-develop rebase remains outstanding, and the reader launch gate stays closed.

### Paired source progress and validation continuation

PAPC-081 accepted the corrected runtime source contract in
`c-20261110141005340` and committed its explicit twelve-ID baseline, matching
instructions and on/off fixtures as `95a2bb593a18ef2f8fbbbf337227cb1bf0d1a53e`.
Its source/installed-module checks are recorded in `c-20261110143038786`; these are
attributed PAPC evidence, not independent runtime review or installed foreground
qualification. This supersedes the outstanding *source contract/configuration*
status above: P1 source agreement and paired P2 implementation are delivered.
P3 installed reader-on/off/read qualification and P4 remain incomplete. The
configuration deliberately omits the reader, and the runtime gate remains closed.

A further `NO_COLOR=1 corepack pnpm test` at `62b11ac` reached the 1800-second
command limit. Root tests passed 42/42; core passed 1924 with 14 skips; OpenCode
passed 106 with one skip; Pi script tests passed 11/11. The Pi source run reported
one explicit failure in `pi-native-host.test.ts` before interruption. Full local
log: `/tmp/pap289-d-34b8ca-test-complete.log`. This remains a failed/incomplete
validation attempt, not a full-suite pass.

The failing completion-turn test passed alone but failed in its full file. Its
registration fixture could open the operator registry, retaining that singleton
when later fixtures changed the database environment. The resulting large list
was correctly bounded into a truncation object, so `.some` was not available.
Commit `23e97cb` isolates the initial registration fixture, closes any previous
singleton before selecting each disposable registry, and asserts the owned path
before writing completion-test events. Array shape is asserted without removing
the original lifecycle/registry checks. No production guard or result limit was
weakened. Pre-repair runs used the operator registry; a native observation confirms
synthetic `d-pap-167-live` remains projected as running. No history was deleted or
manually settled; this needs registry-owner reconciliation, not blind cleanup.

Post-repair command:
`NO_COLOR=1 corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/pi-native-host.test.ts src/__tests__/mode-capability-session.test.ts src/__tests__/pi-extension-composition.test.ts`
passed 25/25 without skips. Pi package typecheck, diff check and staged secrets
scan passed. The full workspace suite has not passed after this repair. Runtime
implementation bytes and the installed trial label are unchanged by this test-only
repair; no new installation, HTTP request, role migration or activation occurred.

The operator accepts the installed readable label for continuing this work. That
choice is recorded separately from exact installed-source provenance and does not
turn `unversioned-dirty-source` into a verified commit. Next owning decisions are
public-egress/transcript-retention acceptance and a bounded qualification route;
no source/fixture pass is substituted for those decisions or genuine human UAT.
