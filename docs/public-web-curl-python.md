# Fixed curl + Python reader — PAP-289 amendment

Source candidate for d-cc669b; **not installed qualification or human UAT**.
Owning direction: PAP-289 `c-20261111125600417` (d-a5f221), explicitly
continued by the operator. This preserves r006, the twelve-ID v4 baseline,
immutable capability selection and the [source-aware response policy](public-web-source-policy.md).
The conversational amendment is not a native exact-package approval or security
review. No historical package or decision is rewritten.

## Discovery and implementation contract

Read the complete r006 requirements/UAT, current ticket handoff, source policy,
mode contract, CLI message standard and the actual prototype tool call. The
selected feature checkout was clean at `ac1c3c2da570344999a30d64ade4dbe1cc41b280`.
No branch switch, checkout allocation/return or canonical-repository edit occurred.

One separately guarded diagnostic GET of the **exact** supplied URL
`https://github.com/jaredpalmer/kev` compared the old extractor and the recorded
Python prototype on the **same bytes**, in memory. HTTP 200, 471608 decoded bytes,
SHA-256 `bd6fd04eea5e6e7533d2a737760cd0482296e662bc4e8850b123c9dceb0a79f8`:
old extraction 1778 code points without `TypeSafeClient`; reference extraction
42202 with it. Neither raw response nor extracted text was retained in a cache or
fixture. This is feasibility/coverage evidence, not an admitted native read,
installed acceptance, proof of a particular malformed attribute, or a hardware
answer. No alternative/linked/raw-README URL was fetched. Diagnostic helper:
`/tmp/pap289-same-bytes.ts`; no additional live request qualifies this candidate.

### Fixed workers and transport

- `packages/pa-core/src/public-web/curl.ts` is the native reader's default
  per-hop transport. System DNS resolution and validation of **all** answers stay
  in their existing owners. The curl boundary repeats URL/sensitive checks and
  rejects a non-public pin before spawn.
- `curl -q` is first; fixed argv arrays, `shell: false`, absolute package-owned
  paths, working directory `/`, and a fresh environment containing only locale
  settings. No runtime PATH/env executable override. No curlrc/netrc, inherited
  proxies, cookies, authorization/referrer, retries, unrestricted flags or `-L`.
- `--resolve host:443:address` pins the checked address at libcurl's connection
  boundary. IP-literal URLs must match the selected pin. Normal hostname/CA TLS
  verification, TLS >=1.2 and HTTPS-only HTTP/1.1 remain mandatory. The existing
  reader revalidates each redirect before DNS or a subsequent process.
- `--include` returns headers plus the still-compressed body through one owned
  pipe, bounded to 2 MiB + 16 KiB. Parsed headers have a separate 16 KiB ceiling;
  the response body has the existing 2 MiB ceiling, as does decoded output.
  Curl does not decompress automatically. Existing bounded gzip/deflate/Brotli
  decoding is reused. Non-200 bodies may be downloaded within that finite bound,
  but are discarded without decompression/extraction/evidence use. This differs
  from the old connector's immediate non-200 body disposal; no redirect is followed
  by curl itself. Curl/TLS/network stderr never enters public diagnostics.
- Curl's pin/TLS implementation replaces the old Node connector as the production
  connection owner. This is an explicit review surface, **not independently
  accepted security equivalence**. The old connector and its disconnected tests
  remain reference/regression code, not the native reader's default path.

`process.ts` owns both workers sequentially: bounded stdout, 16 KiB discarded
stderr, bounded input/backpressure, early exit, cancellation, SIGTERM then SIGKILL,
close/reap observation and a one-second settlement ceiling. A missing close yields
`WEB_CLEANUP`, preserving the existing native session's sticky uncertainty. The
original 29-second work deadline and one-second cleanup reserve, two-read session
capacity, reload/shutdown owners, and no-retry behavior remain. Each worker also
has a finite deadline; Python has 256 MiB address-space, 28 CPU-second and 512-level
nesting ceilings. Process tests are not a measured installed wall-clock SLA.

### Extraction semantics decided before implementation

`extract.py` is the maintained fixed artifact based on the demonstrated
`HTMLParser` article workflow, not a TypeScript parser rewrite. Python runs with
`-I -B`; fetched markup is stdin data, never code, filenames or shell arguments.

- Prefer non-empty visible article text in document order. Nested articles are
  included once; multiple articles are joined. Empty/hidden/no-article documents
  fall back to supported visible document text, not a different URL.
- Preserve headings, list markers, table-cell boundaries, Unicode and code
  indentation. Title is separate bounded text. Plain text remains supported.
- Parse actual attribute names/values. A word such as `hidden` inside an unrelated
  attribute value must not suppress documentation. Suppress actual hidden/ARIA
  attributes, simple inline hidden styles and active/form/foreign contents.
- Ordinary omitted end tags are tolerated; incomplete active/hidden/article/title
  boundaries, partial markup and ambiguous cross-container suppression reject.
  Raw-text parsing prevents apparent parent end tags in script/style/fallback
  content from ending suppression. Non-void `/>` cannot expose suppressed text.
- No JavaScript/browser rendering, computed/external CSS visibility guarantee,
  access-control bypass, universal injection detection, discovery or linked fetch.
  Unsupported/login/challenge/media/UTF-8 behavior stays explicit. Script-only
  pages do not become successful articles.

The old TypeScript extraction algorithm is replaced; its original negative
fixtures now execute the Python worker instead. Result schema, source policy,
URL/final URL/time/evidence, complete decoded-body digest, returned-text digest,
static-not-rendered coverage, extracted-versus-returned counts, clipping and reply
limits are unchanged. Long article text can be clipped at 16000 code points,
2000 lines or the 50 KiB serialized reply ceiling; later README/hardware sections
may be absent. Neither `ok` nor `clipped=false` proves rendered completeness.

### Packaging and dependency failure

The existing `flake.lock` selects curl **8.21.0**, Python **3.14.7** and the pinned
CA bundle. `scripts/build-public-web.mjs` (under pa-core) copies the maintained
script and writes `dist/public-web/runtime.json` with absolute locked paths and
versions. Nix supplies these only as build inputs; source builds evaluate the same
Git flake **offline**. No download/install, runtime executable discovery or manual
installed-metadata patch is performed by this helper. Missing dependencies fail
closed. Node-only development/CI now also needs the locked Nix workers; CI source
changes explicitly materialize them, but hosted CI has not run here.

The Nix output retains script/manifest and dependency store references, with an
install-time extraction/curl smoke check. The existing `.4` readable version is
not a new unique artifact identity for these edits; compare exact source commits.
Select a new trial label through its normal owner before a subsequent installation.
No default config pin, active PAPC configuration or installed runtime is changed.

## Messages and evidence

Touched categories: returned dependency/policy and cleanup blockers only.
Before `WEB_POLICY`: sensitive policy could not load, with an unconditional
no-request claim. After: required reader dependencies **or** native sensitive-input
policy could not load; this read cannot continue. Stage still truthfully records
whether a request may have occurred. Before cleanup referred only to network;
after it includes owned reader processes. Codes/schema/streams/exits and the
five-label envelope remain. Structural NO_COLOR checks cover all existing typed
blockers within 2000 JavaScript units; independent human readability remains due.
No new generic process/shell capability is exposed.

Actual local checks (all `NO_COLOR=1`):

- `corepack pnpm build`, `corepack pnpm typecheck`: passed.
- Core `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1`
  with `src/__tests__/{public-web-workers,public-web-content-source,public-web-reader,public-web-transport,mode-capabilities,sensitive-patterns,interactions-catalogue}.test.ts`:
  **46 passed, zero failures/skips**.
- Pi equivalent for
  `src/__tests__/{public-web-launch,mode-capability-session,document-session,document-native,document-workspace-dispatch,document-confirmation-native,document-confirmation-entry,interactions-discovery-native,interactions-ticket-native,pi-extension-composition,pi-native-host}.test.ts`:
  **61 passed, zero failures/skips**.
- Logs: `/tmp/pap289-workers-{workspace-build,typecheck,core-final,pi-final}.log`.

The new process test compiles a **test-only** connect-syscall shim and runs the
actual locked curl against an owned loopback TLS fixture. Only the approved
synthetic public pin is mapped to that fixture; other connects fail. The shim is
not packaged or used by production. No real private/metadata service is contacted.
Tests verify pinning, TLS trust/hostname checks before HTTP, inherited config/proxy/
credential suppression, decompression bombs, redirect-to-private rejection,
stdout/stderr bounds, missing dependencies, failure, cancellation/escalation and
unknown pipe-owner cleanup. Ordinary TS mocks alone are not counted as curl proof.

Failure history retained: first TypeScript build needed an explicit AbortSignal
annotation; initial source-flake evaluation incorrectly treated a trailing-slash
path as a filesystem flake and timed out copying inputs (no package success).
Using the Git flake fixes it. Initial Python regression run: 10 pass/3 fail (title
parent handling and incomplete markup); second: 12 pass/1 fail (title entities).
Those guards were repaired without dropping negatives. The first actual-curl
harness failed because Linux Node pipe sockets cannot be reopened via `/dev/fd/3`;
`--include` fixes that with bounded header/body accounting. Its next run exposed
an overly strict single-newline fixture expectation, corrected to the intended
paragraph boundary. Final process harness passes all five cases, including cleanup
uncertainty; the full 46-test core run includes it.

Full regression/completion/packaging/scan results are recorded in the continuation
handoff; no completion is inferred from focused tests. Installed foreground exact-
URL read/answer/citation, same-installed-runtime on/off/on, independent security/
code review, hosted CI, genuine human readability/UAT/adoption and develop
integration remain outstanding. Preserve the earlier native denials, wrapper-only
success and trial-only provenance exception as their original evidence.
