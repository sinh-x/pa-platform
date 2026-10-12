# Protected review v1 contract (PAP-237)

The shared parser and Pi static preflight are **observational**, not execution,
review authorization, reservations or evidence of a passing matrix. Pi protected
launch repeats static checks and authenticates candidate/readiness evidence,
uses PAP-232's existing-only selector/reservation and the existing executor,
and consumes authorization through the registry. Command-local assignments remain
opaque shell text; they do not extend launcher environment authority.
OPA/CPA behavior is unchanged. Rollout requires separately approved producers,
installation/readiness and an actual complete protected review, not source tests.

## APIs and failure model

`packages/pa-core/src/validation/review-contract.ts` is exported from pa-core:

- `parseReviewObjective(string | Uint8Array)`
- `parseReviewMatrix(string | Uint8Array)`
- `parseReviewReadinessBinding(string | Uint8Array)` (shape only)
- `parseReviewMatrixSource(unknown)` (exact spelling, no resolution)
- `parseReviewMatrixArtifact(Uint8Array, source)` (raw section/header extraction)
- `readReviewObjectiveFile(absolutePath)`
- `readReviewMatrixArtifact(configuredCanonicalAiUsageRoot, source)`
- `assertReviewContractAgreement(objective, artifact, expected)`
- `formatReviewContractDiagnostic(error)`

The caller supplies existing configured identity/selected comment evidence via
read-only adapters. It must not construct an effectful TicketStore as a read
adapter. The agreement API compares supplied values; **it does not authenticate
author identity, approval durability, worktree selection, ancestry, cleanliness,
installed provenance, prerequisites, a reservation or available review capacity**.
Its typed inputs are outputs of strict parsing or trusted adapters, not a bypass
for validating unknown JSON.

No API writes files/state, starts subprocesses, probes tools, makes network
requests, allocates deployments, claims authorization, increments attempts or
starts matrices. File descriptors are read-only, no-follow/nonblocking; metadata
and raw reads are bounded. Missing roots/files fail without initialization.
Regular-file identity and metadata are checked before/after the read. Launch must
reread: this snapshot is not a filesystem lock or a lifetime reservation.

Errors extend existing `ValidationPreflightError` and contain a stable `code`
and `diagnostic` with `condition`, `source`, `reason`, `correction`, `resumeAction`.
Text uses Condition/Source/Reason/Correction/Resume Action, at most 2,000 JavaScript
characters per diagnostic. Reasons and paths are schema-owned, never supplied
values, unknown field names, authorization IDs or raw OS/JSON error text.

Codes: `REVIEW_SIZE`, `REVIEW_UTF8`, `REVIEW_JSON`, `REVIEW_DUPLICATE_KEY`,
`REVIEW_FIELD`, `REVIEW_VERSION`, `REVIEW_LEGACY_MIGRATION`, `REVIEW_SOURCE`,
`REVIEW_IO`, `REVIEW_BOUNDARY`, `REVIEW_FENCE`, `REVIEW_BINDING`, `REVIEW_PROFILE`.
Parsing is deterministic fail-first: byte/UTF-8/JSON structure first, version,
required fields in schema order, unknown fields, then field semantics in fixed
order. Duplicate keys include decoded escaped equivalents at **every** depth;
known duplicate fields have field-specific locations, dynamic/unknown keys use
`fields` without echoing the key. JSON nesting is limited to 64. The
preflight engine aggregates independent objective-field and binding defects and
reports explicit deferred/blocked checks. Structurally invalid JSON/artifacts
block dependent authority checks rather than using partially parsed authority.

## Common grammar and bounds

- Objective: <=65,536 UTF-8 bytes. Artifact/matrix: <=1,048,576 bytes.
- Commands: 1–1,000, ordered, with unique IDs; never truncate oversized authority.
- One JSON object, UTF-8 with no BOM, malformed encoding or unpaired surrogates.
  JSON formatting whitespace is allowed. Duplicate and unknown keys reject.
- SHA: exactly 40 lowercase hexadecimal characters. SHA-256: exactly 64.
- Ticket: `[A-Z][A-Z0-9]*-[0-9]+`, at most 64 characters (the core canonical grammar). Comment ID: `c-` plus 17 decimal digits.
- ID: `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
- Branch: a valid contained `feature/<ticket>-<topic>` spelling; objective/header/
  readiness branches must name their exact ticket. No Git ref aliases, traversal,
  repeated separators, trailing dots/slashes or `.lock` components.
- Authority strings are nonempty, bounded (normally 4,096 characters), NUL-free,
  with no leading/trailing whitespace. No trimming, case folding or normalization.
- Relative paths: `.` or nonempty slash-separated components; no absolute paths,
  backslashes, colons, empty/`.`/`..` components. Absolute roots must already have
  exact canonical spelling, without dot components or repeated/trailing slashes.
- Timeout/output limits reuse the existing validation schema constants:
  1–1,800 seconds and 1,048,576–1,073,741,824 output bytes.

## Objective: `pa-review-objective/v1`

Exactly these required keys (no optional or unknown keys):

| Key | Type / grammar |
| --- | --- |
| `schemaVersion` | literal `pa-review-objective/v1` |
| `ticket` | ticket |
| `branch` | exact ticket-linked feature branch |
| `featureSha` | full lowercase SHA |
| `matrixSource` | protected source below |
| `matrixAuthoritySha256` | lowercase SHA-256 |
| `matrixApprovalEvidence` | one durable comment ID |
| `reviewAuthorizationId` | `review-auth:` plus canonical lowercase UUIDv4 |
| `prerequisiteEvidence` | object mapping every declared operator-gate ID to exactly one selected comment ID |

UUIDv4 means an exact 8-4-4-4-12 hexadecimal spelling, version nibble `4`, variant
nibble `8`, `9`, `a` or `b`. Parsing retains it for protected internal consumers;
diagnostics never echo it. It must not enter command environments/output.
Parsing/agreement does not consume it or grant a new/fourth/post-cap attempt.

## Matrix: `pa-review-matrix/v1`

Exactly: `schemaVersion`, `source`, `repository`, `profile`, `prerequisites`,
`environment`, `commands`, `commandCount`, `outputs`, `passCriteria`.

- `schemaVersion`: literal `pa-review-matrix/v1`.
- `source`: exact protected prefixed source, including the `requirements:` prefix.
- `repository`: exactly `key` (lowercase repo key), `root` (canonical absolute
  identity root), `baseSha` (full SHA), `branch` (feature branch). Canonical root
  is **not** the execution worktree; later launch supplies the distinct authenticated
  `worktreeRoot` through existing validation interfaces.
- `profile`: one of the three literals below.
- `prerequisites`: array of the following strict tagged objects. Identities are
  unique: one platform, one declaration per tool, one per dependency root/name,
  one per operator-gate ID. Production preflight requires the declared
`paired-runtime-ready` operator gate. No arbitrary probe commands.

| Kind | Exact keys | Semantics |
| --- | --- | --- |
| `platform` | `kind`, `os`, `arch` | exact lowercase OS/architecture identifiers |
| `tool` | `kind`, `name`, `version` | supported tool and exact first stdout line |
| `dependency` | `kind`, `root`, `name`, `version` | contained package root, npm package name (including scoped names), exact semver |
| `operatorGate` | `kind`, `id`, `ticket` | ID and exact ticket; explicit objective comment selection |

Supported tools: `node`, `npm`, `pnpm`, `corepack`, `pi`, `git`, `bash`, `nix`.
Version lines follow the fixed probes' forms: `vX.Y.Z` for Node; `X.Y.Z` for npm,
pnpm, Corepack and Pi; `git version X.Y.Z...`; `GNU bash, version X.Y.Z...`;
`nix (Nix) X.Y.Z...`. Ranges, floating labels, multiline versions and guessed
unsupported tools reject. Actual tool/package checks belong to authorized launch;
pnpm uses Corepack with network and automatic package-manager pinning disabled
for fixed tool probes. Missing cached tooling fails; no installation or repair
is allowed.

| Profile | Required structural declarations |
| --- | --- |
| `node-pnpm/v1` | one platform; exact Node, Corepack, pnpm versions; explicit dependency roots when needed |
| `npm-subprojects/v1` | one platform; exact Node/npm versions; explicit roots such as backend/frontend, not assumed root node_modules |
| `non-node-nix/v1` | one platform; exact Nix version; no invented Node tools or package dependencies |

Other supported non-Node tools may be declared. Dependency versions are exact
semver, not ranges. Package metadata must later resolve inside the authenticated
worktree; existing pnpm indirection is acceptable only with contained resolved
metadata. Parsing a relative declaration does not prove live containment.

### Environment, commands, outputs and pass criteria

The environment object contains **exactly eleven names**. Each value is exactly
one strict `{ "binding": ... }` or `{ "literal": ... }` object:

| Name | Required representation |
| --- | --- |
| `PA_REPO` | binding `worktreeRoot` |
| `PA_FEATURE_SHA` | binding `featureSha` |
| `PA_MATRIX_SOURCE` | binding `matrixSource` |
| `PA_MATRIX_AUTHORITY_SHA256` | binding `matrixAuthoritySha256` |
| `PA_MATRIX_APPROVAL_EVIDENCE` | binding `matrixApprovalEvidence` |
| `PATH` | binding `trustedPath` |
| `PA_TICKET_ID`, `CI`, `HOME`, `LANG`, `TZ` | literal strings; ticket must match selected ticket |

`commands` is an ordered array of objects with exactly `id`, `command`, `cwd`,
`timeoutSeconds`, `maxOutputBytes`. Shell text is opaque, nonempty and NUL-free:
retain exact whitespace/inline assignments. Do not infer launcher variables from
command strings (PAP-235). `cwd` is contained relative to the later authenticated
worktree, not the canonical root. `commandCount` equals the complete array length.

`outputs` contains one string per ordered command, `"<id>: <nonempty description>"`.
`passCriteria` has exactly these mandatory literals:

```json
{
  "completionPercent": 100,
  "exitCode": 0,
  "critical": 0,
  "major": 0,
  "minorRationaleRequired": true
}
```

These are independent **later acceptance gates**, not conclusions from parsing,
reviewer startup, mocks or phase-focused checks. Failures/skips/crashes cannot pass.

## Protected source, raw bytes and agreement

A source is exactly `requirements:agent-teams/requirements/artifacts/<path>.md`.
Resolve only the path portion beneath the configured canonical AI-usage directory.
Preserve the entire prefixed string everywhere. Bare/generic doc refs require
migration; absolute/traversal paths, symlink roots/ancestors/leaves, non-regular
files and aliases reject. A permissive generic doc-ref resolver is not authority.

The artifact must contain exactly one unambiguous `### Full Validation Matrix`
line outside fences. Alternative heading levels, closing hashes, whitespace aliases
or fenced lookalikes reject. Its raw byte section starts at that heading's first
byte and ends **before the next unfenced level-1-to-3 ATX heading** (required).
Level-4-to-6 headings do not end the section. Unclosed fences reject.

The section contains exactly one exact ` ```json ` / ` ``` ` pair (without the
spaces used here to display the markers) and one exact `Matrix Source: <source>`
line. No second/ambiguous/alternative fence is executable authority. Hash all raw
section bytes including heading, JSON formatting, policy prose, newlines and
whitespace, excluding the terminal heading. LF and CRLF recognition does **not**
normalize hashing: they have different approved digests. Byte offsets remain
correct with non-ASCII text before/inside the matrix.

Before the section, require exactly one of each header:
`> Ticket:`, `> Repository Key:`, `> Repository Root:`, `> Approved Base SHA:`,
`> Feature Branch:`, `> Matrix Authority SHA-256:`, `> Matrix Approval Evidence:`.
Values use one separating space. Approval is either an exact comment ID or
`<ticket> comment <id> by sinh` followed by optional descriptive prose containing
no second comment ID. The approved PAP-237 header form is supported.

Agreement compares header/repository/ticket/branch/base, section/payload/objective
source, raw/header/objective/approval digest, and header/objective/selected-comment
ID. The supplied selected approval has exactly the conceptual tuple
`commentId`, authenticated `author: sinh`, `ticket`, `branch`, `matrixSource`,
`matrixAuthoritySha256`. The adapter must verify durable comment author/content,
not infer approval from this document. Objective gate keys must be exactly every
matrix operator gate, and gate/environment tickets must agree.

## Readiness binding shape

The selected operator-gate comment must be durably authored by Sinh with
one unambiguous JSON object:

- `gateId`, `ticket`, `branch`, `featureSha`, `matrixSource`,
  `matrixAuthoritySha256` (same exact grammars as above).
- `installedRuntime`: exactly `binary` (absolute `/nix/store/<32-char hash>-<name>/bin/ppa`),
  `packageName` (ID), `packageVersion` (nonempty), `sourceSha` (full SHA).
- `mergedConfigSha`: full SHA, later compared with the installed runtime's paired
  config pin and the clean merged config checkout. For `pa-platform` self-review,
  it must also equal the candidate's `.pa-platform-config.sha`.
- `pap232Evidence`, `pap235Evidence`: durable `PAP-232/c-<17 digits>` and
  `PAP-235/c-<17 digits>` references to Sinh comments on completed integration
  tickets. The readiness approval binds the selected references explicitly.

A version label or echo of expected SHA alone is not provenance. Actual
store/package/source identity, merged pin and integration references must be
independently authenticated and bound to the tuple at launch. The launcher
compares its own physical module location against the selected store package and
`review-runtime-provenance.json` packaged with `sourceSha` from the clean Git
flake revision, package version and config pin. Runtime `sourceSha` is independent
of an external project's target `featureSha`; external projects need no PA config
pin file. Only `pa-platform` self-review additionally requires the runtime source
to equal that candidate SHA and its config pin. Dirty/unversioned packages cannot
pass readiness.

## Explicit migration only

Legacy prose objectives, unversioned JSON, generic inline-command/prerequisite
matrices and bare sources reject with `REVIEW_LEGACY_MIGRATION`. Unsupported
versions reject, never fall back. To migrate, publish a **new** persistent versioned
artifact with a **new exact source/raw digest**, obtain durable Sinh approval and
select appropriate gate comments. Do not rewrite historical approved artifacts,
alias their digest, fabricate approval, adopt manual/rogue evidence, reset
counters/caps, or imply historical retry entitlement (including PAP-189).

`packages/pa-core/src/__tests__/fixtures/protected-review-v1/README.md` records
isolated MVM-179/NX-055/MVM-181 copied shapes and synthetic new producer fixtures.
All use replaced identities and synthetic approval/readiness; they never migrate
real historical authority. Source tests and isolated installed smoke are not
actual protected-review acceptance. Full acceptance requires the independent
approved matrix, paired producers and live worktree/readiness/integration gates.

## Pi preflight and rollout

```sh
ppa review preflight --ticket PAP-237 --objective-file request.json
ppa review preflight --ticket PAP-237 --objective-file request.json --json
```

Exit 0 is static-compatible, 1 incompatible, 2 usage/I/O failure. Reports use
`pa-review-preflight/v1`, deterministic checks/diagnostics and deferred launch
checks, without capability/token values. Preflight reads only existing regular
files and configured registry metadata; it never constructs TicketStore or opens
the SQLite registry. Missing state remains absent. No Git/tool/runtime/project
probe, network call, deployment ID/workspace, claim, attempt or matrix start occurs.
The same default gate runs before Pi protected deployment allocation, including
`--dry-run`. The public PPA CLI calls the adapter's observational gate before
repository/Git resolution or TicketStore construction and preserves raw JSON
instead of generic prose sanitization/trimming. Decoded commands/literals are
sensitive-checked as well as raw bytes, so JSON escaping cannot hide credentials.
Compatible dry-run primers redact plain and JSON-escaped authorization IDs too.
`deploy --validate` is only team configuration validation.

Launch rereads artifact/ticket/approval, authenticates the distinct candidate,
checks installed readiness, then preserves the durable matrix-start boundary
before live prerequisite observations and atomic authorization consumption.
Reservation-bound execution rereads source/profile/environment/readiness/receipt
and exact tools/dependencies, including a post-matrix boundary reread before
reviewer startup. Exit-zero commands cannot certify an unchanged candidate.
Legacy active reviews remain exclusion evidence;
uninterpretable running same-ticket authority conservatively blocks admission.
Matrix and reviewer termination are tracked independently: post-matrix rejection
with verified executor completion and no reviewer still publishes matching final
candidate evidence and clears only its reservation. Arbitrary executor crashes or
unresolved cleanup never imply termination. Terminal authority finalization does
not return or alter the checkout.

The config producer follow-up owns `contracts/protected-review-v1.json`:
`schemaVersion: "pa-review-producer-fixtures/v1"` and `fixtures`, exactly three
entries containing `profile`, `objective`, `artifact`. Paths must be contained
under `contracts/fixtures/`; each profile must occur once. Strict source/digest/
header/objective pairing is checked by `verify:paired-config -- --require-review-v1`
on the exact clean merged config pin. Baseline `verify:paired-config` preserves
existing CI compatibility; it does not prove v1 pairing. Protected launch always
requires v1 pairing regardless of CLI flags. Missing pairing fails rollout; this
repository never rewrites canonical producers or silently updates the config pin.

Implementation-first merge is distinct from rollout: Sinh selected this scope
for PAP-237 in rogue-one d-5318f0. PAPC-039 producers, separately completed
PAP-235 evidence, durable installed readiness and actual authorized protected
review/UAT remain deferred. No legacy review, failed matrix or rogue result is
adopted as passing protected acceptance.

`pap-237-installed-preflight-smoke.mjs` compares packaged provenance against the
expected candidate and invokes the installed CLI on isolated synthetic evidence
for all profiles and legacy rejection, trapping static writes/process/network
calls. It never launches a real reviewer or consumes live authority. Historical
executor regression tests use explicitly labeled trusted dependency seams; they
are not v1 producer, installed or live-review proof.
