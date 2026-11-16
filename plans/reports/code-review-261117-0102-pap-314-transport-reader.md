# PAP-314 transport and reader review

## Code Review Summary

**Two reproducible P2 defects need correction before closing the P1/P2 review.** The 61 focused tests pass, but they do not cover the real owner's typed-error propagation or ambiguous source aliases.

### Scope

- Candidate: `f5b47f58ef81c38f9f28e4775109a0e575e8fbe1`; reviewed implementations remained unchanged during this review.
- Transport: `packages/pi-pa/src/local-review-cli.ts`, `packages/pi-pa/src/local-review-server.ts`, and their two `src/__tests__/local-review-*.test.ts` files.
- Routing: `packages/pi-pa/src/cli.ts` and `packages/pi-pa/src/document-cli.ts`.
- Reader: `packages/pa-core/src/documents/reader.ts`, `src/__tests__/document-reader.test.ts`, and `src/__tests__/document-reader-summary.test.ts`.
- Scoped P1/P2 diff: nine files, 1,072 additions and 19 deletions against `93c8126`. Existing renderer, validation, worker and opening dependencies were inspected for caller-contract context.
- Read `AGENTS.md`, `docs/cli-message-standard.md`, `docs/PAP-314-local-review-contract.md`, and the implementation plan. Applied the scout protocol and both blocking/informational passes of the base/API review checklists.
- Moving P3 handoff owners were excluded. The pinned P1 parser/dispatcher contract was consulted only to verify what the transport's real callee throws. No source, plan state, credentials, live databases or actual human decisions were changed. Authentication is intentionally absent; runtime defaults remain PAPC-090 work.

### Critical / High Priority

None proven within this scope. Deliberately unauthenticated local confirmation is not a finding. The inspected paths do not claim authenticated human consent.

### Medium Priority — blocking findings

#### 1. [P2] The transport discards trusted core rejection causes

**Locations:** `packages/pi-pa/src/local-review-cli.ts:56–58,70–74`; `packages/pi-pa/src/local-review-server.ts:152–156`.

`executeCoreLocalReview` lets the real core's `DocumentPackageError` escape, but `localReviewFailure` recognizes only errors registered in its transport-private WeakMap. Consequently, known `DOCUMENT_INPUT`, `DOCUMENT_CONFLICT`, `DOCUMENT_STALE`, `DOCUMENT_AUTHORITY` and `DOCUMENT_UNCERTAIN` rejections all become `LOCAL_REVIEW_INTERNAL`. HTTP then treats them as server errors. Clients lose the distinction between a rejected request, stale/conflicting review coordinates, retained uncertainty and an unexpected infrastructure exception. This also drops safe owner cause information required by the CLI message standard.

**Reproduction:** Submit a normal `show` request with one forbidden `actor` field. The default core throws `DOCUMENT_INPUT` before opening stores. The actual source CLI returns exit 1, empty stderr and stdout code `LOCAL_REVIEW_INTERNAL`; the real HTTP endpoint with its default handler returns HTTP 500 and the same code. Disposable-root readback confirmed that no stores/files were created. The current propagation tests instead inject an owner that *returns* `{ok:false,...}`, which does not exercise this production contract.

**Fix:** Translate only verified, allowlisted typed core failures at the core/adapter boundary into bounded public owner causes; preserve their machine distinction and appropriate client-rejection status. Keep arbitrary exceptions/proxies on the existing sanitized unknown-result path. Add real-default-owner CLI and HTTP tests for malformed/duplicate/unknown fields, plus isolated trusted conflict/stale/uncertainty cases. Do not infer authority or reconciliation from exception prose.

#### 2. [P2] Ambiguous aliases silently redirect a source link to another member

**Location:** `packages/pa-core/src/documents/reader.ts:70–77`.

The same Map contains package-root source names, document-relative paths and short aliases. Unconditional `set` calls silently overwrite another member's alias, making link destinations depend on inventory order. Both members can pass package validation because their actual source paths are distinct.

**Reproduction:** Let `B` be `agent-teams/requirements/artifacts/reviews/EX-1/r001`. Put the brief at `B/overview.md`, the requirements at `B/requirements.md`, and a later specification at `B/B/requirements.md`. The brief's supported package-root link `[Requirements](B/requirements.md)` is first mapped to requirements, then overwritten by the specification's relative alias. Rendering succeeds, but the brief's member page links to `member-4.html#member-4` instead of requirements at `member-2.html#member-2`. The executive and complete views inherit the same misdirection. Existing link checks pass because the wrong destination still exists.

**Fix:** Detect aliases that resolve to more than one member and leave them inert or reject the ambiguity. If canonical package-root paths have precedence, reserve them before adding relative/short aliases and never overwrite them. Add this collision fixture in multiple inventory orders and assert the *intended member identity*, not just target existence.

### Edge cases and verification

Scouting followed input framing into the actual owner, timeout/disconnect handling into admission-slot release, and arbitrary inventories into generated links. Existing focused checks cover loopback binding, exact/duplicate Host, Origin/browser rejection, compression/trailers, UTF-8 and byte limits, socket/operation admission, lost replies, bounded output, complete member inventories, raw-source hashes, local navigation and hashed inert CSP. No additional concurrency defect was reproduced; pending owner work retains its admission slot after timeout/disconnect.

Commands ran with `TZ=Asia/Saigon LANG=en_US.UTF-8 NO_COLOR=1`:

| Command | Result |
| --- | --- |
| `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 src/__tests__/local-review-cli.test.ts src/__tests__/local-review-server.test.ts` | 27 passed; exit 0. |
| `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-reader-summary.test.ts src/__tests__/document-reader.test.ts` | 19 passed; exit 0. |
| `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1 src/__tests__/document-reader-worker.test.ts src/__tests__/document-reader-opening.test.ts` | 15 passed; exit 0. |
| Scoped `git diff --check 93c8126..f5b47f5` | Passed; exit 0. |

Two additional inline, disposable probes reproduced findings 1 and 2. The first used the real CLI, default dispatcher and HTTP endpoint with malformed input rejected before I/O; the second rendered only an in-memory package. No probe was added to source.

Worker tests used the existing built worker; no build or distribution regeneration was performed. Full suites, typecheck, lint, coverage measurement, installed verification, browser/accessibility observations, human readability acceptance and hosted CI were not run. Type/test coverage percentages and lint counts are therefore unmeasured, not passing claims.

### CLI message and plan follow-ups

- Affected message categories are discovery/help, listener information, returned owner failures and thrown transport/owner failures. Source inspection and focused CLI tests confirm that local-unverified trust is explicit, failure output remains bounded JSON, failing stdin requests exit 1, and partial-output failures do not append a second stdout document.
- Before/after discovery: the previous help offered only `document describe --format json` and directed readers to authenticated foreground Pi; current help also exposes `document review --help` and explicitly distinguishes local decisions from human identity evidence.
- Failure example, observed versus recommended (not applied): forbidden input currently becomes `LOCAL_REVIEW_INTERNAL` / HTTP 500 / “outcome is unproven.” It should retain a bounded known input-rejection cause without claiming that an effect started. Truly unknown/partial effects must retain the existing uncertainty warning.
- The plan marks P1/P2 complete. Recommend adding the two regression cases and correcting these defects before accepting that closure. Do not change P3/P4/P5 status from this limited review; PAPC-090 activation and genuine installed/browser/human evidence remain separate.

### Unresolved Questions

None needed to act on these findings. Moving P3 behavior remains outside this assessment.

Status: DONE_WITH_CONCERNS
Summary: Read-only P1/P2 review completed with two reproduced P2 defects; all 61 focused tests passed.
Concerns/Blockers: Preserve typed core rejection causes and prevent ambiguous reader aliases from selecting the wrong member.
