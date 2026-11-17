# PAP-314 local review contract

Status: P0 design contract retained; P0–P3 runtime source is committed at b537789. This is not installed qualification or product acceptance.
Companion configuration work: **PAPC-090**. Runtime source only in PAP-314.
Current source coverage, client examples and qualification boundary: [P4 runtime integration handoff](PAP-314-runtime-integration.md). The dated design below is preserved; this status/link update grants no live authority.

## Revised trust model

Sinh explicitly requested a simple trigger/approval workflow without authentication during d-8b21a0. The new version is **local unverified confirmation**. Any local process able to reach its loopback endpoint can submit a decision. It is not authenticated human consent, not hostile same-UID isolation, and must never be advertised as either. Authentication requirements in the original FR-06/AC-14 are deferred for this new contract, not silently marked satisfied. Existing native Pi v1 evidence and old document scopes remain unchanged.

No credentials, actor names, imported receipts, supplied roots/base SHAs, programs or shell actions are accepted. Static document HTML remains inert. A future authenticated contract must use a different explicit version/provenance; it cannot relabel historical unverified decisions.

## Version and ownership

The new immutable capability `document.local-review` requires `document.handoff` and `document.package`. It selects `pa-handoff-native/v2` / `pa-handoff-review/v2` only for fresh qualified requirements/analyze. Omitted capabilities, v1 requests, retained selections, OPA, background and resume do not gain local confirmation or cross-session continuation. PAPC-090 owns eventual default selection and full process closure.

Reuse `RegistryHandoffReviewJournal`, `HandoffReviewService`, the reader, publication, Git/ref/link and queue owners. No second approval ledger. A v2 subject additionally binds its original native caller coordinates, allowing local review/status after that Pi UI ends without pretending a new session adopted writer custody. Origin coordinates are distinct from the currently authenticated effect caller; never return an ended origin as a running caller. A dedicated v2 continuation seam may exempt only the exact proven origin history after repository/ticket owners prove no live or uncertain custody, and must still validate the original plan/link and reject unrelated owners. Current caller identity, original association/audit and effect IDs remain unchanged. Fresh selected Pi continuation rechecks these facts at every remaining write; v1 guards remain unchanged. External approval is not general source or resource authority. Every local action requires a persisted v2 subject and verified original immutable selection of all three capabilities; v1 subjects cannot even be read through this surface.

## Shared operations

`ppa document review` provides strict JSON requests on stdin (`--request-stdin`) and discovery (`--help`). The dedicated `ppa document review serve --port N` binds **127.0.0.1 only**, never the general agent API server. `POST /v1/review` accepts the same bounded request document; `GET /v1/health` exposes version/trust only. No CORS, cookies or query credentials. Reject browser Origin requests, wrong Host, non-JSON content, unknown/duplicate fields, excessive bodies and unsupported methods. Limits: 64 KiB request, strict UTF-8/depth-64 JSON, 8 KiB headers, 16 sockets, one active operation/no queued work, 5-second header/body/write deadlines, 30-second total-operation deadline and 32 MiB serialized response. Reject overload or over-limit output rather than truncating. Health does not initialize stores. Responses use no-store; reject duplicate/nonexact numeric Host, compression, query strings and any Origin (including null). Errors never echo request bodies or arbitrary exceptions. This reduces cross-site accidents; it does not authenticate local callers. Starting this dedicated server is explicit and deliberately exposes eligible v2 review contents to other local OS users. Hashes are identifiers, not credentials; there is no enumeration or arbitrary file route.

Requests use `schemaVersion: pa-local-review/v1` and one action:

- `show`: `subjectSha256`. Full exact subject, intent, inventory, document content, delivery links, current eligibility, history and separate effect states.
- `request`: `subjectSha256`, `expectedRevision`. Persist original review request before returning, without UI or effects. Identical original coordinates reuse the request.
- `decide`: `subjectSha256`, `expectedRevision`, `requestKey`, `outcome`. Outcome is approve/request changes/reject/cancel (`approved`, `changes-requested`, `rejected`, `cancelled`). Only exact persisted pending coordinates can issue. Identical replay returns the original result; a changed outcome conflicts.
- `revoke`: `subjectSha256`, `expectedRevision`, `decisionId`. Request-only: persist/return a distinct revocation request and its requestKey without issuing revocation. Finalize through `decide` with returned original pre-request expectedRevision/requestKey; approved revokes the persisted target, other outcomes do not. Never roll back completed effects.

Local decisions record `principal: local-unverified`, server timestamps, generated interaction IDs and an explicit unauthenticated evidence method. No request may set provenance. expectedRevision always means the original pre-request revision, not the current post-request length. Persist accepted outcome/generated interaction/time atomically with issuance, or recover only those same saved bytes; changed-outcome retries conflict even after reply loss. Intentionally pending v2 requests remain decidable; uncaptured v1 requests retain uncertainty semantics. Pi v2 foreground review uses this same request/issue owner; v1 retains its genuine native foreground path. CLI/API support review/status only; publication/ref/queue remain finite Pi owners. No claim of CLI/API effect parity.

## Approval boundary and effects

Before preparing final review and again before issuing approval, read-only eligibility checks cover lifecycle/assignment, primary/predecessor refs, source/delivery integrity and pending native effects. Blocked final approvals report causes; explicit content-only reviews need not grant unusable effects.

Reobserve canonical LOCAL `refs/heads/develop` at approval issuance under repository→ticket→journal serialization. No lock spans human reading; no fetch. For unissued captures compare develop against observedDevelopSha (not the original reuse base). Drift appends a stale/non-grant disposition, not an invented user outcome, and returns old/new full SHAs. Only selected native refresh/prepare may create the successor plan/review: prove the exact predecessor plan and unchanged planned link under repository→ticket→journal serialization with complete-ticket CAS; preserve old plan/request/audit/link attribution, reject uncertain/partial effects and require a new deliberate approval. CLI/API only report stale state and never invoke planning. Refresh/repeated drift and reply loss retain original operation coordinates. A successful observation defines the approval boundary; later movement never retargets the issued pin. Reuse preserves the original native base and advanced ancestry.

Publish every source and complete HTML/manifest/decision attachment before requirements-primary promotion. Then physically verify and correlate ref/link, then queue only with exact scope. No worktree, lease/capacity, checkout switch, stash/reset/discard, push or launch. Existing owner uncertainty, CAS, revocation fences and same-operation recovery remain controlling.

## Qualification

P0 security review must acknowledge intentionally absent authentication, strict version isolation, loopback/browser-request limits and no false human provenance. Each implemented surface needs source/propagation/negative tests. Installed normal defaults require PAPC-090. Genuine browser/accessibility/readability, installed foreground CLI/API/Pi, hosted CI and Sinh UAT remain separate evidence and cannot be synthesized by tests.
