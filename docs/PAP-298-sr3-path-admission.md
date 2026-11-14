# PAP-298 Phase 2c — protected-path admission before Pi existence probes

Source implementation candidate following `7cab0f16261156a582fe483f81cbd3094b0aee81`;
existing PAP-298 ticket worktree/feature branch, implementer d-6cf785.

## Independent review consumed

Independent deployment **d-d30304** completed normally without repository mutation.
Full report:
`/home/sinh/Documents/ai-usage/deployments/d-d30304/artifacts/PAP-298/security-re-review.md`.
SHA-256 verified:
`c9046b6a88064b973f98c4a531fbf54ae8e527c52ff826bb3316831335ad21a3`.
Its disposition on exact `7cab0f1`: original SR-2 payload/MIME/FIFO defect repaired at
source level; SR-1 bootstrap architecture conditionally adequate, but production
HIGH enabling gate remains OPEN. Independent F38/C16/additional4 probes passed;
the additional probe confirming SR-3 was not a zero-preflight acceptance pass.

**SR-3 MEDIUM:** Pi's own path resolver performs F_OK existence checks before
`operations.access`. Reviewer observed one existence probe on an inert `.env`
before `LOCAL_SOURCE_BLOCKED`, zero payload reads. This is inherited metadata I/O,
not reopening the repaired MIME content-read/FIFO defect. No independent report
has reviewed this subsequent Phase 2c source change yet.

## Repair and deliberate compatibility bound

New adapter owner `local-read-paths.ts` enumerates original and normalized logical
spellings and the inspected local Pi 0.84.4 resolver's finite fallback candidates:
AM/PM narrow space, full-path Unicode NFD, curly apostrophe, NFD plus curly apostrophe.
It also preserves normal relative paths, @ prefix, home expansion and file URLs.
Enumeration is pure; no upstream private-subpath imports or path-existence probes.

The guarded read loads valid policy, honors pre-abort, then admits the entire
bounded candidate set **before** delegating to Pi execute. Existing policy checks
logical/protected paths before required realpath checks. Callback acquisition also
requires membership in the admitted set and still repeats source/descriptor policy
and stability validation. Source policy may necessarily observe resolved metadata;
this is not a claim of zero filesystem I/O on every denial. The removed behavior
is upstream existence preflight on an as-yet-unadmitted logical candidate.

Conservative ambiguity rule: if **any** original/normalized/fallback candidate is
protected or its policy cannot be evaluated, deny the whole request before Pi
probes, even when a different safe spelling already exists. Otherwise a disappearance
between admission and upstream existence selection could send Pi into unadmitted
fallbacks. No safe-looking spelling grants access to a protected alternative.
Ordinary supported relative/alias/text/image behavior remains under its existing
owners; safe spelling variants are exercised through the actual guarded executor.

This mirrors the finite **inspected local** Pi resolver contract. A future host
with additional spelling probes needs renewed source/integration qualification;
the callback membership guard alone cannot retroactively authorize its preflight.
Do not promote source tests to installed/future-version proof. No Pi dependency
version was changed. No message wording, error union, capability, permission,
artifact owner, root/trust exception or public CLI form changed in Phase 2c.
Inventory reconciliation tracks the new owner and changed adapter hash; effect/
operation identities and retained admission remain unchanged.

## Actual checks

Focused command:

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
  packages/pi-pa/src/__tests__/local-source-security.test.ts \
  packages/pi-pa/src/__tests__/local-read-paths.test.ts \
  packages/pi-pa/src/__tests__/local-image-type.test.ts \
  packages/pa-core/src/__tests__/local-source-file.test.ts \
  packages/pa-core/src/__tests__/source-content-security.test.ts \
  packages/pa-core/src/artifacts/__tests__/manifest.test.ts
```

Initial exit1: **42 pass/1 fail**. New unit expectation decomposed the first accented
word but mistakenly left the second accented word composed. Corrected the expected
**whole-path** NFD spelling, not production behavior. Original log retained at
`/tmp/pap298-sr3-focused-initial.log` (SHA-256 below).
Final exit0: **43 pass**, no failures/skips/cancellations. Includes actual direct
returned and registered safety-thrown protected-path calls with **zero upstream
F_OK probes and zero payload reads**, resolved blocked aliases, protected fallback/
original spellings, safe relative/@/space/NFD/screenshot/quote delivery, unit home/
file-URL/invalid-input cases and the retained reader/image/FIFO/artifact matrix.

- `corepack pnpm typecheck`: exit0, all workspace projects.
- `corepack pnpm build`: exit0, all workspace projects.
- Composition command from `PAP-298-sr2-reader-repair.md` (requirements-tool-parity,
  mode-capability-session, pi-extension-composition, interactions-catalogue and
  interactions-discovery, sequential node --import=tsx --test): exit0, **16 pass**,
  no failures/skips/cancellations.
- Diff and staged secrets checks apply before commit; the scanner only covers the
  staged candidate, not every possible secret/input.

Local log SHA-256 pins:

```text
59cbf3165258f51b3f1828f9cd2b4a018f65d0d362c95f7cbba63aa88d9d4538  /tmp/pap298-sr3-focused-initial.log
b074d8070748bf67d0897ede9541cd8c3a6366f8eefdc2a81db0f1cc9da4da3c  /tmp/pap298-sr3-focused-final.log
884dfa2b8684a5e53c8f0fb81b10084fa0d78d5f85a4ad269c6cb9aca28f8399  /tmp/pap298-sr3-typecheck.log
55f822adab12ca3302f0e682f1390a6cbde650f92790822bd038c144f175ee7f  /tmp/pap298-sr3-build.log
9662932b447b1079be36aa39d83c5b5675c7faab6f6feb44603163fac4662132  /tmp/pap298-sr3-composition.log
```

Full workspace test/completions were not rerun for this later candidate. The
previous full-suite timeout remains incomplete, not converted into a pass by these
focused results. No hosted CI, new independent exact-code review, installed reader
trial or genuine human clarity/UAT occurred in this phase.

## Remaining work and explicit owner scope

SR-3 has an implementer repair candidate requiring independent re-review. SR-1
still has no implemented trusted producer and **all hard links remain denied**.
Sinh separately authorized investigating **Pi 1.4.0** packaging and proposing exact
reproducible Pi/Node/payload pins before dependency or launcher changes. That is
investigation/proposal scope, not approval of guessed pins, installation, runtime
selection, changed dependency or the positive exception. No denied installed docs
may be obtained via another reader to perform that investigation.

Next: identify the exact candidate packaging inputs/layout/Node/rollout decisions
for owner selection, retain the reviewed bootstrap premises, and re-review concrete
code before enabling. No downstream PAP-287/PAPC-064 resumption, custody effect,
ticket Done transition or checkout return is justified by this source repair.
