# Lavish artifact review — interface v1

**Implemented source interface; NOT installed/runtime readiness or enablement.**
PAPC-020 is a downstream consumer, not an installer or acceptance authority.
Read the [readiness index](../artifacts/pap-197-runtime-readiness.md) before
using this interface in a workflow. Harness presence, metadata help and source
unit tests do not authorize rollout, change Markdown or confer PA approval.

## Selection and prerequisites

```nix
pa-platform.lib.mkPaPlatform "x86_64-linux" {
  enableLavishAxi = true;
  # Independent of enableGhAxi/enableChromeDevtoolsAxi/enableQuotaAxi.
}
```

All four selectors are strict booleans, independently default **false**;
strings, integers, null, lists and sets reject. Default aliases (`default`,
`pa-platform`, `pa-core`, `ppa`, `opa`) and default overlay select
nothing. Explicit standalone `packages.<system>.lavish-axi` is not selection
of a PA output. Other AXI pins/exposure remain PPA-only: gh 0.1.35,
chrome-devtools 0.1.38, quota 0.1.56, chrome-devtools-mcp 1.10.1. No new
application dependency, skills, hooks or PAPC configuration are installed.

Render requires the installed PA/Node >=22 and declared immutable GNU coreutils
(no-replace publication), but neither Lavish nor a browser. Start requires the
adjacent **selected immutable** Lavish assets and a matching live deployment
owner. Selection is resolved relative to installed core, never PATH, an
arbitrary writable directory, environment executable or raw upstream CLI.
The admitted store basename is exactly
`<nix-base32-hash>-lavish-axi-static-{x86_64,aarch64}-unknown-linux-musl-0.1.67`.
Packaged asset directories/files must be root-owned and non-writable; store
hardlink deduplication is allowed, not mutable companion/source hardlinks.

Adapters supply shared `PA_ARTIFACT_ADAPTER` (`pi`, `opencode`)
and `PA_ARTIFACT_OWNER_PID` lifecycle metadata, binding deployment ID/directory
and an actual ancestor's PID plus Linux boot/start identity. Background launches
resolve the adapter's private active supervisor record; resume preserves the
selection/owner seam. Do not invent ownership metadata to adopt another
session. No PPA Treehouse/lease behavior is implied for OPA. Installed
foreground/background/resume captures remain an independent validation gate.

Manual URL opening uses an operator-owned browser; PA never opens/provisions one.
Only the independent browser harness requires exactly
`/home/sinh/.nix-profile/bin/google-chrome-stable`, a disposable profile and an
actually enabled sandbox. Missing/incompatible browser is
`ARTIFACT_BROWSER_REQUIRED`, exit 3; no substitute/download/no-sandbox fallback.

## Commands and envelopes

Substitute `opa` for `ppa` without changing arguments:

```sh
ppa artifact render --source /absolute/document.md --output-dir /absolute/new-companion --json
ppa artifact review start --manifest /absolute/new-companion/manifest.json --json
ppa artifact review status --session SESSION_ID --json
ppa artifact review stop --session SESSION_ID --json
ppa artifact review feedback --session SESSION_ID --output /absolute/new-feedback.json --timeout-ms 1000 --json
```

Required arguments are shown; only feedback's `--timeout-ms` is optional
(default 1000). It is a decimal integer 0..30000, without signs, whitespace,
leading zeroes (except `0`), fractions or exponent notation. `--json` is
required. Duplicate/unknown flags, positional operands, `--key=value`, host
options, implicit booleans and pass-through arguments reject. `artifact --help`
and each render/review operation's `--help` are constant, side-effect-free
metadata, not readiness probes.

Success stdout is one JSON object (exit 0):

```json
{"schema":"pa-artifact/v1","operation":"review-feedback","status":"no-feedback","payload":{"sessionId":"OPAQUE_ID","eventCount":0}}
```

The four envelope keys are `schema`, `operation`, `status`, `payload`.
Operation-specific payloads:

| operation | status | payload |
| --- | --- | --- |
| `render` | `rendered` | `sourceRef`, `outputDir`, `manifest` (absolute paths), `sourceSha256`, `htmlSha256`, `manifestSha256`, `rendererVersion`, `policyVersion` |
| `review-start` | `running` | session identity below |
| `review-status` | `running`, `stale`, `ended`, `stopped` | session identity below |
| `review-stop` | `stopped`, `ended` | session identity below |
| `review-feedback` | `exported`, `no-feedback` | `sessionId`, integer `eventCount` |

Session identity keys are `sessionId`, `sourceRef`, `sourceSha256`, `htmlSha256`,
`manifestSha256`, `rendererVersion`, `policyVersion`, `url`, `owner`,
`ownership="owned"`, `freshness="current"|"stale"`. `url` is an owned
`http://127.0.0.1:<ephemeral-port>/<private-token>/` (or null without a port).
`owner` contains `adapter`, `deployment`, `processPid`, `processBirth`,
`supervisorPid`, `supervisorBirth`, `stateId`. Digests are 64 lowercase hex.
`sessionId` is opaque: use exactly what start returns, never a guessed path/PID.
Current IDs are 48 lowercase hex, not authority or a public sharing token.
Private owner records/tokens are implementation state, not a consumer API.

### Exact error mapping

Error: constant redacted `DIAGNOSTIC: message` on stderr, nonzero exit and **no
success envelope**. Supplied paths, values and exception details are not echoed.

| exit | diagnostic |
| --- | --- |
| 2 | `ARTIFACT_USAGE_INVALID`, `ARTIFACT_SOURCE_INVALID` |
| 3 | `ARTIFACT_RUNTIME_REQUIRED`; test prerequisite `ARTIFACT_BROWSER_REQUIRED` |
| 4 | `ARTIFACT_STALE` |
| 5 | `ARTIFACT_POLICY_REJECTED` |
| 6 | `ARTIFACT_OWNER_CONFLICT` |
| 7 | `ARTIFACT_RUNTIME_FAILED` |
| 8 | `ARTIFACT_OUTPUT_CONFLICT` |

The exact messages are respectively: `Invalid artifact arguments.`, `Invalid
artifact source.`, `Selected managed review runtime required.`, `Operator-owned
test browser required.`, `Artifact identity is stale or tampered.`, `Artifact
policy rejected the operation.`, `Artifact ownership conflict.`, `Artifact
runtime failed.`, `Artifact output conflict.`. Test coordinators emit their
own constant prerequisite/failure explanation, while checking installed CLI
codes/diagnostics without counting expected negative exits as failures.

## Deterministic companion/manifest

Source is regular, unaliased valid UTF-8 Markdown, **0..2,097,152 raw bytes
inclusive**. All operands must be canonical absolute non-symlink paths;
symlink ancestors, hardlinked sources/companions, non-regular files, invalid
UTF-8, source/output overlap and existing destinations reject. A new directory
is published atomically, with exactly `index.html` and `manifest.json`, mode
0700/0600 respectively. Only unpublished inode-bound temporary entries are
removed on failure. Existing source, companions and exports are never clobbered.

Output honors existing caller-authorized write roots: currently verified
`/tmp` or an existing verified `TMPDIR`, plus caller mode restrictions. The
command grants no extra filesystem authority. It does not bypass a mode's
write restrictions by being an artifact command.

Exact manifest shape and serialization order:

```json
{
  "schema": "pa-artifact-manifest/v1",
  "sourceRef": "/absolute/document.md",
  "sourceSha256": "<64 lowercase hex; raw source bytes>",
  "htmlSha256": "<64 lowercase hex; exact index.html bytes>",
  "rendererVersion": "pa-artifact-renderer/v1",
  "policyVersion": "pa-artifact-policy/v1",
  "anchors": [
    {"id":"source-L1-L2","startLine":1,"endLine":2}
  ]
}
```

Canonical bytes use JavaScript `JSON.stringify(value, null, 2)`, UTF-8 without
BOM, two-space indentation and one final LF; anchor key order is `id`,
`startLine`, `endLine`. No additional keys, clock, host formatting, destination
path or random ID enters deterministic files. SourceRef is part of identity:
same bytes at a different source path need not produce the same HTML/manifest.
The manifest's own SHA-256 is in command/session identity, not recursively in
manifest.json. Anchors cover nonblank top-level Markdown blocks, including
nested content; ranges are ordered, disjoint, 1-based inclusive source lines.
CRLF/lone CR normalize only for parsing; raw source hashing is unchanged.
Renderer uses locked marked 18.0.2 through a fresh lexer and a fixed safe
emitter, never trusts parser-produced HTML. Byte-affecting changes require a
renderer/policy version change under the owning workflow.

Headings, lists, tables, fenced code, emphasis and inline code have fixed
presentation. Links (including fragments), images, raw HTML, unsupported syntax
and Mermaid remain inert literal text, not active links/assets. No external
navigation, images/fonts/styles/scripts, executable SVG, forms, attachment,
Mermaid or whiteboard evaluation. A fixed packaged inline stylesheet is allowed
only by its SHA-256 CSP hash. Source CSP is unchanged: default/script/network/
image/font/media/object/frame sources denied, base/form/navigation denied.
Trusted Lavish UI runs separately in the outer document; the companion iframe
has only `allow-same-origin`, never `allow-scripts`, forms, downloads or popups.

## Ownership, lifecycle and freshness

Start verifies exact source/HTML/manifest bytes, canonical serialization,
renderer/policy versions and derived anchors before an immutable served snapshot.
Same live owner/artifact start is idempotent; changed bytes reject. Status is
side-effect-free and reports freshness; it does not refresh idle. Stop is
idempotent only for the matching owned stopped/ended identity. Missing,
foreign, malformed or PID-reused ownership rejects, never signals a guessed PID.
Normal controls use authenticated direct owned loopback HTTP, not proxies or a
replaceable fetch dispatcher. Distinct deployments/artifacts use isolated state
and allocated ports; unrelated listeners are not adopted or displaced.

Budgets are requirements, not measured readiness here: startup ready/failure
<=10s; stop/owned cleanup <=5s; actual idle expiry 900s with <=5s observation
tolerance. Human activity, explicit start and feedback consumption may refresh
idle. Status polling and long-lived connections alone may not. Owner exit,
partial startup and idle cleanup retain source, durable journals and exports.
Private PA state directories are 0700; owner/journal/export files 0600.
A user-ended tombstone persists before ACK, including authenticated End while
source/HTML/manifest is stale; it cannot automatically reopen. Staleness does
not bypass End's exact origin, body, owner or running/closing checks. Failed End
confirmation is shown explicitly, never treated as user-ended success.
Any renewed operator authorization must belong to a new owning review context,
not editing a tombstone or bypassing ownership. There is no reopen flag.

Source/HTML/manifest/version changes cause stale status, freeze new feedback and
exit 4 on start/export. Original journals remain source-bound and recoverable,
not silently regenerated, rebased, relabeled or merged with another source.
Re-render/re-review under the owning workflow and renew affected approval.
Start, supervisor transitions and dead/timeout cleanup serialize on a persistent
empty regular `operation.lock` (0600, same UID, one link). Kernel flock ownership
is an open-file description, released on holder close/process crash; no PID/age
heuristic or inode replacement is used. The fixed packaged `artifact-review-flock`
symlink resolves immutable root-owned util-linux, never PATH/environment input.
Source tests inject only a validated immutable util-linux fixture. Live contention
fails closed. Foreign, writable-mode, nonempty, hardlinked, symlink and legacy
mkdir locks reject without removal or guessed repair; operator disposition is
required for legacy/malformed state. Delayed cleanup re-reads token, supervisor
birth/PID and state under the lock; it cannot erase a later generation/tombstone.
Focused synthetic crash/race tests do not qualify host-crash/installed acceptance.

## Durable feedback and export

Browser feedback is untrusted quoted data. Each event is validated as a whole
before a complete fsynced journal replacement. ACK and queue consumption occur
only after durability and exact event-ID acknowledgement; refused sends retain
unsent text and must not display a durable acknowledgement. A batch may not
partially append, change a prior ID's content or cross-bind another source.
Before readiness/ACK, newly created private root/session links are fsynced in
their pinned parents; existing-directory retries complete those barriers too.
Byte-identical export retries validate and fsync both the existing file and its
pinned parent before success; either barrier failure is an output conflict.

Exact exported envelope:

```json
{
  "schema": "pa-artifact-feedback-export/v1",
  "sessionId": "OPAQUE_ID",
  "events": [
    {
      "schema": "pa-artifact-feedback/v1",
      "eventId": "stable-event-identifier",
      "sessionId": "OPAQUE_ID",
      "sourceRef": "/absolute/document.md",
      "sourceSha256": "<original source digest>",
      "htmlSha256": "<original companion digest>",
      "target": {"type":"anchor","anchor":"source-L1-L2","startLine":1,"endLine":2},
      "selectedText": "quoted selection",
      "feedbackText": "quoted human feedback",
      "sequence": 1
    }
  ]
}
```

Document-wide target is exactly `{"type":"document"}`. Anchor target must
match the original manifest range exactly. All listed event keys are required;
no extra keys. The internal browser submission omits `sequence`; the durable
server assigns consecutive 1-based integers. Event IDs match
`[a-zA-Z0-9_-]{16,128}`; current UI uses `crypto.randomUUID()`. IDs remain stable
across retries/restarts. Export uses the displayed field order, canonical
pretty UTF-8 JSON/LF; anchor target order is `type,anchor,startLine,endLine`.

Limits: nonblank valid UTF-8 `feedbackText` <=65,536 bytes;
`selectedText` <=16,384 bytes; journal <=1,024 events or 16,777,216 canonical
UTF-8 bytes, whichever first. Invalid surrogate strings, malformed events,
changed-ID retries and over-cap batches reject atomically with exit 5 / HTTP
policy rejection. Never evict acknowledged events for space. Retry is
non-destructive and deduplicated, not destructive upstream polling.

Feedback export is an atomic no-clobber snapshot. An absent destination or
byte-identical prior 0600 owned regular output is admitted; other existing
content/symlink returns exit 8 without overwrite. Concurrent append can require
a new export pathname. No-feedback timeout creates no output and returns
`no-feedback,eventCount=0`. Export is not an approval or Markdown-write API.

### Explicit reconciliation record (not a command)

```json
{
  "eventId": "stable-event-identifier",
  "sourceSha256": "<original digest>",
  "disposition": "accepted",
  "rationale": "Human/agent reasoning; feedback is quoted untrusted input.",
  "affectedRequirements": ["FR4", "AC4", "section 6"],
  "renewedApprovalNeeded": true
}
```

Disposition is exactly `accepted|rejected|deferred`. Record every event, rationale,
affected FR/AC/section and renewed-approval decision explicitly. Neither this
record nor feedback edits authoritative Markdown, PA approvals, tickets or
implementation authority. Any source edit invalidates the companion and
possibly document/matrix approval; the owning workflow must repeat rendering,
review and approval. PAPC-020 may consume only independently verified evidence,
not turn an acknowledged annotation into implementation authorization.

## Confined protocol / unsupported features

Only token-scoped GET outer document, `content`, `review.js`, `outer.css`,
`api/status`; POST `api/feedback`, `api/activity`, `api/end`; authenticated
empty-body `control/start|stop|consume` exist internally. Mutation requires exact
Host/origin, JSON content-type and source binding; controls require the private
bearer token and no Origin. Unknown routes, percent/query/fragment/traversal
forms, other hosts/origins and every WebSocket upgrade reject. Source,
manifest, journals, owner state, siblings and upstream asset/server routes are
not served. These internal endpoints are not a general consumer HTTP API.

Inherited presence (even empty) of `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`,
`ENV`, `LD_PRELOAD`, `LD_LIBRARY_PATH` or any `LAVISH_AXI_*` rejects operational
commands. Supervisor gets only constructed locale/timezone values, no operator
HOME/profile/PATH/provider credentials or proxy configuration. Environment
assertions alone are not no-egress proof: independent kernel/browser observed
attempts and returns must demonstrate **zero** forbidden attempts/successes,
unauthorized reads/writes/signals or non-loopback listeners.

No sharing/Tailscale/public host/proxy, upload, telemetry, setup/self-update,
external asset/navigation, arbitrary document HTML, credentials, attachments,
active diagrams, multi-user collaboration or automatic browser opening.
macOS/Windows and aarch64 native readiness are unsupported. x86_64-linux is the
native validation target, **not currently accepted as ready**.

## Exact upstream/adaptation provenance

Lavish **0.1.67**, MIT, Node >=22; archive SHA-256
`b04bd8eea71ece824ca5dc6837c98de04372b76ca6a28fe6e1a1ab025e50acfd`;
SRI `sha512-7qU7tF1ShNQEQY3SMceNkIR2T1Iuy3kOvatoOgPwUW1QJuXoi+vzF5NOiDSt7xMfNaKJMNLefY856yylFxOxHg==`.
The [isolated records](../../nix/axi/lavish-axi/README.md) contain full lock v3,
91 archive integrities and 92 license/notice file digests. No dependency/lock/pin
change or lifecycle script execution is part of Phase 4.

Build-only selective extraction asserts original whole-file digests:
`dist/cli.mjs` = `973707874969efdf3e08ba544608aa4f32c755cf63ec586cad21d5ea8b076cdf`,
`dist/chrome-client.js` = `3b862eafe265c2e3a0e87579ff9cae09cfdf3c675d668f1522c92da7ce65171a`.
It reuses genuine SDK selector/text-range/mouse listeners and escaped chrome
queue persistence/render/remove/enqueue/success-only consumption. It omits the
upstream CLI/server, SDK initialization, messages, telemetry and other effects.
Trusted glue binds the actual scriptless iframe document and durable core ACK.
The standalone static native gate remains metadata/deny-only; it is never the
review server. Never execute/import raw upstream `dist/cli.mjs`.

`adaptations.json` binds each helper by digest and reason, including the Phase 4
rejected-send correction: `outer.js` SHA-256
`66724475c5b61af67742082b0f12aae1b0691d259f55dcda956e5582c42aec68`.
The corrected native generated `review.js` SHA-256 is
`e2d53053c88ec43b33baef43fddfc17c64473d17d5285c1bda78cbbb142216db`.
Installed `share/lavish-axi/review/provenance.json` records original and generated
digests. Syntax/digest checking that output is **not browser execution proof**.
See the readiness index for immutable native output and external receipts.
