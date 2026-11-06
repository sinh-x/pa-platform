# Requirements document capabilities (PAP-283)

Runtime source implementation; **not installed qualification or human acceptance**. PAPC process/composition and joint qualification are dependent phases. Existing `pa-review-bundle/v1`, pinned workflow runs, native decisions and pair publication retain their original semantics. No migration, approval replay or builder admission is performed.

## Selection and ownership

A paired PAPC mode explicitly opts in with:

```yaml
name: requirements
# other existing team settings retained
deploy_modes:
  - id: analyze
    document_profile: pa-document-package/v1
    # existing role/provider/model settings retained
```

The parser rejects this field on any other role/mode or with another version. The Pi launcher selects `requirements-document-capabilities/v1` only for this supported **fresh, unpinned foreground** route, without inherited builder admission or selection-only worktree intent. An immutable started event records selection. Legacy PAPC without the field is unchanged. Installing a skill alone does not select the route. Do not enable the field before the complete PAPC instruction closure is updated and qualified.

Native authentication rechecks running registry identity, original launch event, canonical registered root, original process-incarnation anchor, live process lineage, foreground session, ticket correlation and absence of builder/resource custody. Neither model prose nor an environment marker selects or upgrades a route. `--resume` does not upgrade a historical deployment; package continuity is available from a fresh authenticated requirements/analyze session via `status`/`show` and the original operation identities.

PAPC owns the conversational process. Runtime provides supporting functions, not a graph or next-step selector. This route exposes artifact/ticket tools and guarded reads; it denies shell, generic source edit/write, Git, execution, preparation, policy activation and resource operations. Draft writes are deployment-scoped outside product source. `pa_document` registers lazily only after a genuine native document session starts; legacy managed tool inventories remain unchanged. Native current-ticket changes follow exact existing `ticket-associated` owner events without rewriting the immutable launch/environment. The existing protected-path and sensitive-content policies remain active. General ticket comments are narrative, never native decisions.

## Exact package

`pa-document-package/v1` binds an ordered inventory, canonical repository, ticket, immutable package/revision, predecessor and finite publish/optional queue effects. Required fields:

- `schemaVersion`, `packageId` (lowercase ID), `revision` (positive integer), `repository: {key,root}`, `ticket`, `predecessor` (prior published subject SHA256 or null).
- `members`: each `{id,role,mediaType,source,description,bytes,sha256}`. Exactly one `brief`, `requirements`, `uat`; additional `specification` members as justified. Every member is approval-relevant and required. No branch, workflow, command catalogue, execution matrix or source-writing permission exists here.
- `references`: informative `{locator,version,description}` metadata, never fetched or implicitly treated as approved specifications.
- `effects: {publish:true,queue:boolean,route:{team:"builder",mode:"orchestrator"}}`. Queue changes only ticket status/assignment; it does not launch a builder or allocate/return resources.

Sources are relative to the native AI-usage artifact root and confined to `agent-teams/requirements/artifacts/{drafts,reviews}/`. Text is UTF-8 Markdown/plain text; PNG/JPEG are opaque snapshots with a description and signature checks, not executed or decoded as active content. SVG/HTML/script media are unsupported. Active markup/secret-bearing text rejects locally. Safe media support is not a claim of image observation or an installed preview.

Limits: 64 members, 1 MiB per textual member, 8 MiB per image, 16 MiB total, 64 KiB metadata/request. The brief additionally has a 1,000-word/16 KiB native presentation limit. Structural checks report this bound. Authored content is not silently truncated for approval. Publication destinations are derived under `agent-teams/requirements/artifacts/packages/<ticket>/<packageId>/rNNN/<member-id>.<extension>`; callers cannot supply destinations.

## Public interfaces

Static CLI discovery, with no store access, capture or effects:

```sh
ppa document --help
ppa document describe --format json
```

Native tool: `pa_document`, with exactly one `request` string containing strict JSON. Duplicate/unknown keys, invalid UTF-8, unsafe identity and oversized requests reject. The exported `DOCUMENT_ACTION_FIELDS` is the canonical action field inventory; CLI discovery reports it. All tool operations require the native supported session, not merely matching JSON.

| Action | Required fields besides `action` | Behavior |
| --- | --- | --- |
| `capabilities` | none | Honest toolkit inventory; preview unavailable, templates use existing unsigned `pa_template`. No readiness claim. |
| `status` | `ticket` | Current ticket journal revision, bounded frozen snapshot locators and unresolved effect identities. Use after a lost response or fresh-session continuation. |
| `ticket-create` | `title`, `content`, `intakeId` | Ticketless project-bound intake under the existing ticket mutex. Fixed requirement-review/requirements assignment. Same intake tag plus exact title/description reuses an existing ticket; conflicting/multiple matches reject. Not package approval or a protected workflow queue receipt. Preserve its tag and returned identity; do not replace an uncertain intake with a new ID. |
| `discover` | `path` (`.` or relative directory) | Selected local directory only, at most 256 entries examined/128 returned, no symlink recursion or remote discovery; sensitive names omitted. |
| `context` | `path` | Selected local project text only, 1 MiB read bound and explicit 16,000-character excerpt plus exact hash. No implicit fetch/crawl. |
| `draft` | `path`, `content`, `expectedSha256` | Unsigned text under `agent-teams/requirements/artifacts/drafts/<native deployment ID>/`. Null means absent; updates require exact prior hash. Reuses protected descriptor-confined file mechanics and the ticket mutex. Never writes canonical publication or product source. |
| `check` | `package` | Structure and declared FR/AC/TS references only; returns findings, not semantic completeness. Failed findings do not disable unrelated work. |
| `freeze` | `package`, `expectedRevision` | Snapshot exact subject/member bytes atomically in the existing registry. Preserve prior versions; conflicting same package/revision rejects. The snapshot is unapproved. |
| `show` | `sha256` | Issued snapshot, decision/revocation history, pending effects and recent results. |
| `read` | `sha256`, `path`, `offset` | `path` is a member ID. Full immutable text is paged in 8,000-character chunks; start offset 0 and follow `nextOffset` until null. Image snapshots remain opaque. |
| `compare` | `sha256`, `previousSha256` | Additions/removals, hashes/roles, changed text excerpts around the first differing line, effect/reference differences. Full versions remain readable. Materiality is not inferred. |
| `capture` | `sha256`, `expectedRevision` | Native foreground exact-package decision; no graph/branch/catalogue. Displays brief, member inventory, informative-reference labels, finite effects and exclusions. Full content must be made accessible before final review. Approve/request changes/reject/cancel; optional technical bindings. Rereads sources, caller and CAS before persistence. |
| `revoke` | `sha256`, `expectedRevision`, `decisionId` | Genuine foreground revocation; completed effects are not undone. |
| `publish` / `queue` | `sha256`, `expectedRevision`, `decisionId` | Owner-checked operation or same-intent reconciliation. No caller actor/outcome/approval/grant/import field. |

`expectedRevision` is the **repository/ticket journal revision**, not the authored package's revision. Obtain it from `status`/`show` or a returned operation. A stale request rejects; reread actual state, never assume an absent effect. Freeze returns `snapshotRef: registry-document-package:<sha256>`. Record it and material feedback in the existing ticket-linked continuity record using actual ticket administration; those comments do not mint native evidence.

## Decisions, publication and recovery

The existing SQLite registry owns immutable subject/member/native-presentation snapshots and append-only document evidence, with CAS and version dispatch separate from graph replay. Native transcript bytes resolve through the recorded evidence hash. Public requests cannot import a decision. The current final decision must be affirmative and unrevoked for each new effect; a later rejection/revocation never resurrects an earlier grant. Source/member/membership/effect changes require a new subject and decision.

Publication/queue serialize with **all** TicketStore writers through the existing mutex. An exact durable intent precedes external effects. Publication creates only absent directories/files, reuses exact partial members, attaches every required nonprimary ref, then promotes requirements after the complete set is proven. Historical bytes/ref metadata survive. Filesystem plus ticket storage is not claimed physically atomic. Conflicting/unknown bytes are not overwritten or cleared. A different package/decision cannot bypass an outstanding intent. Old workflow admission and new protected document effects exclude each other's controlling state.

Queue requires current full publication and matching finite effect authority. It sets pending-implementation/builder/team-manager under lifecycle/assignment checks; implementing/review/terminal tickets are never reset. An active implementation amendment is not automatically supported by this route; obtain an explicit owner-supported handoff.

After interruption, use `status`/`show`, then the **same** publish/queue operation and decision with the current journal revision. Proven completed work is observed, not replayed. An already-issued intent whose full external result is proven may settle even after revocation, without new external writes. Unproven repairs still need current authority. Uncertain/failed results stay in history. Never substitute a new lineage, fake receipt, imported approval or blanket cleanup.

Results use operation-local completion/outcome/enforcement/capability facts (shared `OperationResult` vocabulary). `ok` means a service invocation returned its findings, not that semantic checks/UAT passed. `DOCUMENT_INPUT`, `DOCUMENT_SOURCE`, `DOCUMENT_STALE`, `DOCUMENT_AUTHORITY`, `DOCUMENT_CONFLICT`, `DOCUMENT_UNCERTAIN`, `DOCUMENT_UNAVAILABLE` are local failures. Oversized native responses retain correlation/outcome metadata rather than falsely labelling a durable effect absent.

## Validation and outstanding qualification

Source suites: `document-package`, `document-service`, `document-integrity`, `document-process` (core) and `document-native`, `document-session` (Pi). They exercise real disposable SQLite/files/ticket owners, four-process single-winner publication, process death after ticket boundaries, lost queue replies, stale/foreign/forged inputs, immutable successors, complete-before-primary, nonapproval/revocation and non-downgrade behavior. Synthetic UI/principal fixtures are **source evidence only**, not human decisions or installed acceptance.

PAPC must implement the canonical guided process, flexible versioned templates, objectives/shared helpers, fresh route configuration and full generated composition checks against these actual interfaces. New native OpenCode parity is not delivered; existing OPA/common-core routes must regress cleanly.

The dedicated [installed document qualifier](document-installed-qualification.md) now supplies 62 mandatory exact-installed identity/document/default-entry IDs; source-built driver units are not installed passes. [Validation lanes](requirements-validation-lanes.md) keep the exact historical JSON runtime/config separate from PAP-283/PAPC-077 and explicitly supply PA_PLATFORM_REPOSITORY. Joint P4 remains separate: a clean exact compatible installed runtime/config pair, actual qualifier execution, genuine normal foreground TS-1–TS-18 trial, independent review, CI and Sinh UAT. This implementation does not activate/install a candidate, claim those observations, change this ticket's original draft approval provenance, or authorize push/merge/resource return. A matching producer is optional: manual drafts are honestly agent-authored, never fake canonical renders.
