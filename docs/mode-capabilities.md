# Config-owned Pi document capabilities (PAP-289)

Status: source implementation candidate, **not installed, qualified or activated**.
Audience: runtime/PAPC maintainers and independent reviewers. Product authority is
PAP-289's published `pap-289-config-capabilities/r006` requirements and UAT package.
This page documents the source contract, not a replacement approval or matrix.

## Selection and compatibility

Only a fresh foreground, unpinned, non-resumed Pi `requirements/analyze` start can
select `document_profile: pa-document-policy/v1`. It requires `capability_policy`
with exactly `version: pa-mode-capabilities/v1` and `allow: [...]`. Selection is
replacement, not additive; `[]` grants no model-selectable tools. Native lifecycle
and operator commands are not model tool grants. No other role/adapter migrates.
Present invalid policies reject; retained absent-policy v1/v2/v3 routes keep their
old contracts. OPA rejects this Pi-only selection rather than ignoring it.

The launcher reads committed `teams/requirements.yaml` using
`CommittedConfigSource`, requires the loaded mode and committed selection to
agree, and rechecks source drift before native start. The immutable execution plan
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
| `document.package` | `pa_document` | `document-native.ts`; package grammar, v3 confirmation owner |
| `document.workspace` | `pa_workspace` | `document-workspace.ts`; bounded workspace grammar; no network |
| `ticket.read-comment` | `pa_ticket` | `ticket-tool.ts`; read/show/list/comment and ticket owner |
| `bulletin.read` | `pa_bulletin` | list active bulletins |
| `registry.read` | `pa_registry` | show/list bounded registry data |
| `status.read` | `pa_status` | one deployment status |
| `template.draft` | `pa_template` | list/show/render/validate, unsigned selected-template owner |
| `human.question` | `question` | human question; never native protected approval |
| `session.todo` | `todo` | session-local task lifecycle |
| `context.read` | `read` | existing canonical project/artifact/config path and content guards |
| `web.public-read` | `pa_web_read` | `public-web/reader.ts` + `web-read-tool.ts`; staged supplied-public-HTTPS reader; launcher qualification gate remains closed |

A configuration preserving the full baseline explicitly lists the first ten IDs.
For example (synthetic, not an instruction to edit active config):

```yaml
- id: analyze
  document_profile: pa-document-policy/v1
  capability_policy:
    version: pa-mode-capabilities/v1
    allow: [document.package, document.workspace, ticket.read-comment, bulletin.read,
            registry.read, status.read, template.draft, human.question, session.todo,
            context.read]
```

Unknown/duplicate IDs, wildcards, tool-name aliases, null/wrong/extra fields,
unsupported profiles/versions, duplicate YAML keys and merge-key inheritance reject.
The selected resource is at most 64 KiB UTF-8; policies have at most 64 unique IDs,
each at most 128 ASCII characters. The finite current registry is smaller than the
upper bound: a 64-element array of unknown IDs still rejects. New IDs require a
runtime implementation, not a config override.

## Staged public-page reader

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
  are unsupported; access controls are never bypassed.
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
locator `pi-tool-result:<deployment>/<toolCallId>`. This locator identifies the
existing transcript result, not a new persistent cache or an external artifact.
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
Socket disposal gets a bounded one-second settlement wait; unproven closure is
explicit, never inferred from cancellation. Deadline fixtures are not a measured
installed wall-clock SLA under host scheduling or synchronous extraction load.

### Privacy and activation status

Direct DNS/HTTPS discloses hostname/path/query to the applicable DNS/network and
destination operators. The original supplied input and returned text remain in
the existing model transcript/retention domain. Native sensitive checks prevent
outbound/returned matches; they cannot retroactively erase an already supplied
user prompt or detect every possible secret. No new web cache, raw-body audit,
external extraction service or separate retention sink is introduced. Public GET
can cause remote side effects: the tool instructs agents not to read known action
URLs and does not pretend to prove that a URL was selected by a human.

**The launcher still returns `CAPABILITY_UNAVAILABLE` for `web.public-read`.**
Source registration and synthetic native starts are not public-egress activation.
A proposal to open the staging gate first needs runtime/PAPC contract review and
approved exact public routing/retention, then an explicitly admitted qualification
candidate/pair. Qualification must measure deadlines, shutdown/reload/replacement
and same-runtime config toggles; independent review, required CI and genuine human
UAT/adoption remain separate before live use. A source gate edit alone cannot
satisfy any of those obligations. No active policy, external PAPC source,
installation or egress setting is changed here.

## Verification and rollout boundaries

Focused source tests: `public-web-reader.test.ts`, `public-web-transport.test.ts`,
`mode-capabilities.test.ts`,
`mode-capability-session.test.ts`, registry/plan/team and retained document tests.
They use disposable native registries/process evidence and synthetic tool/UI seams.
Reader tests use synthetic DNS/TLS/socket/content fixtures; an in-memory Duplex
also exercises the real Node HTTPS request/response parser without network access.
Cases cover unsafe/mixed answers and redirects, peer/certificate mismatch, fixed
headers/proxy non-use, bodies/decompression/Unicode/output, secret canaries,
cancellation, deadline checkpoints, concurrency, unknown cleanup and native on/off
admission. They are not a real DNS/TLS/public request, installed foreground session,
human readability review or UAT.

PAPC must review this exact schema/profile, preserve the complete baseline and
provide matching selected instructions in its separately admitted repository.
The same qualified runtime must demonstrate reader-on/off in separately authorized
new starts, without a rebuild. Current sessions must stay unchanged. No active pin,
installation, public-egress activation, remote push/PR or checkout return is
performed by this source change. Independent review, hosted CI, installed tests,
human clarity/usefulness/UAT and explicit adoption remain separate obligations.

Before: the retained document hook described a fixed artifact/ticket tool route.
After: selected-route blockers distinguish malformed/unknown policy, unsupported
profile, unavailable implementation, unproven binding and omitted capability.
They use fixed, plain, bounded five-field guidance from `modeCapabilityDiagnostic`;
formatting performs no probes/effects and never echoes raw config or errors. Existing
retained messages and machine contracts are unchanged. The registry binding fields
are intentional additive machine-contract changes, not wording-only alterations.

Reader messages are additional returned tool-result paths: invalid input, native
policy unavailable, unsafe target, sensitive data, unsupported content, bounds,
HTTP/network failure, cancellation, timeout, busy capacity and unknown cleanup.
`publicWebDiagnostic` is pure fixed typed text with the same five-label/2000-unit
blocker contract, never raw exceptions or URLs. Success and clipping warnings are
ordinary outcome/coverage prose. Before: URL selection stopped at the unavailable
launch gate. After (source fixtures only): a selected native reader returns actual
fixture text/provenance or a typed bounded blocker; the live launch gate remains
unchanged. Structural message tests are not independent human readability review.
