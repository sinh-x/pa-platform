# PAP-298 Phase 2b — concrete selected-host bootstrap proposal

**Design only; independent review requested. Nothing in this document enables
hard-link reads.** Implementer d-6cf785; source repair parent
`f4300164057e44d3043a63b7ece33842006b08f2`; existing ticket branch/worktree retained.
Sinh authorized host/bootstrap design work via structured question, excluding an
unreviewed exception, dependency bump, installation or active runtime selection.

Consumes d-426bad SR-1: the Phase 1 opaque-identity sketch had no authenticated
producer. SR-2's separate source-reader candidate is documented in
[PAP-298-sr2-reader-repair.md](PAP-298-sr2-reader-repair.md) and still needs exact-code
independent review. This proposal replaces the abstract host-identity sketch; it
is not a claim that the proposed packaging/launch contract already exists.

## Decision proposed to reviewer and runtime/packaging owner

**Own execution of one immutable selected Pi payload; do not infer which package
ran by inspecting PATH, wrapper prose, environment, argv, version or peer imports.**
The future Nix package would select a Pi payload and Node host as explicit pinned
build inputs and generate a literal-bootstrap entrypoint that itself executes that
exact Pi payload. Its private active state is the producer. The read adapter consumes
only that producer's live document-acquisition service, never an asserted package
root or a caller-minted token. An ordinary external `pi` launch has no producer and
therefore no hard-link exception.

This is a material launcher/packaging integration, not a tiny prefix exception.
The owner must approve the **concrete Pi/Node build selection and launch behavior**
after design review, before implementation of that integration. No target version
is selected here. Source/package peer 0.84.4 and historical installed Pi 1.4.0 must
not be silently substituted for one another. No new user/model root allowlist or
environment configuration field is proposed.

## Current source facts versus proposed changes

Current `flake.nix` packages pa-platform and selected AXI tools, but has no trusted
selected-Pi-payload binding. `adapter.ts` foreground/managed launch paths invoke
`pi`; native-host discovery finds a Node executable for compatibility using PATH
and wrappers. These do not establish executing-module -> document-package identity.
The source reader now denies all multi-link files with no eligibility override.

Proposed integration points, not existing files/APIs:

- Nix output: a private selected-host build record, bootstrap and ESM bridge beside
  installed pi-pa; literal links to selected Pi payload and its actual Node host.
- Adapter/native-host/background-runner/start-gate paths: use the same pinned
  launcher/Node selection for execution and compatibility probes when selected.
- Extension: consume the exact native bridge service for qualified multi-link text;
  otherwise keep the ordinary single-link reader. Capability guards remain first.
- pa-core: share descriptor mechanics if useful, but keep artifact owners unchanged
  and do not expose an `allowHardlinks` option through ordinary/model calls.

No integration code, flake input, dependency, spawn target or native API is changed
in this design phase. Exact implementation/API qualification is a later obligation.

## Producer contract — build custody, then actual execution

### B1. Trusted build-time selection

The packaging owner supplies a pinned Nix Pi derivation and its matching Node
runtime, with a reviewed relative package root and **actual JavaScript CLI payload**
inside that derivation. These are evaluation/build inputs, never runtime JSON/env.
The package name/version and CLI relationship are checked at build time; the CLI
file must belong to that package, not a shell wrapper selected by parsing text.
The owner must identify the real payload layout for the chosen Pi release. A
`main()` export or a historical `dist/cli.js` location is not assumed.

Generate a strict internal record containing:

```text
schema: pa-selected-pi-host/v1
selectedPiStoreObject: exact build-selected store object
packageRoot: exact contained package directory
cliModule: exact contained JavaScript entry module
nodeExecutable: exact matching immutable Node executable
bootstrapModule / bridgeModule: exact own installed module identities
README.md / docs / examples: component-safe contained document roots
build selection identity: digest of canonical record and pinned inputs
```

The record is installed in the immutable pa-platform closure and matched against
literal module references emitted by the same build. Merely possessing a JSON file,
matching its self-hash, or seeing a store-looking path is **not** proof. Trust comes
from the selected immutable installed bootstrap and its build-selected references;
the record describes that selection rather than granting arbitrary roots.

Runtime must authenticate the own installed closure and exact selected Nix objects
from those fixed references, pin safe directories and require root-owned nonwritable
package/store-object/document components. A development checkout, writable/foreign
root or supplied record is ineligible. `/nix/store`'s group/sticky write semantics
are a boundary requiring explicit review: pin its exact object entry and reject
replacements; do not pretend the store parent has no write bits. This trusts the
Nix/root installation owner, not arbitrary root-owned files elsewhere or hostile
root changes between syscalls. NAR contents/signatures are not inferred from a
store-name regex. If the deployment cannot authenticate this installed build custody,
this contract cannot activate; no metadata-only fallback is offered.

### B2. Bootstrap owns the executing Pi module

Launch the fixed Node with the fixed bootstrap as its **initial script**, not
`pi` resolved by PATH. Before importing Pi, bootstrap verifies the fixed selection
and process identity. Reject unsupported loader/preload/eval/require/import hooks,
nonempty inherited NODE_OPTIONS and conflicting executable/startup evidence;
otherwise a loader could redirect even a literal import. Adapter launch must use
the intended environment explicitly, not silently ignore a conflict. Kernel current
process executable/entry-script/birth observations corroborate this execution route;
they do not select or authenticate a package by themselves.

A single native ESM bridge owns the complete launch lifecycle. Proposed interface:

```text
runSelectedPi(): Promise<void>                 // no root/record/token arguments
acquireSelectedPiDocument(path, patterns, signal): OwnedCheckedSource | denied
```

`runSelectedPi` may activate once, only under the verified initial bootstrap process.
It pins the fixed build selection, creates private process-lifetime state, and
**itself performs the literal native import of the build-selected CLI payload**.
It never accepts a callback alleged to run Pi, accepts an install-identity setter,
or returns a grant for another launcher. Import/load failure, launch conflict,
shutdown or lifetime mismatch revokes state. Invocation from an arbitrary script,
external Pi, smoke/eval harness, or duplicate launch is ineligible even if it can
import the bridge. Calling a private launch function cannot bless arbitrary code:
it has no alternate target and must execute the selected payload itself.

Pi's actual extension may ask for document acquisition while the CLI import is
running; that is the only active lifetime. If the selected CLI import returns before
the host/session lifetime ends, this design must be adapted and reviewed against
that release's real lifecycle rather than leaving a guessed live flag set. A failed
or completed import must never silently confer permanent eligibility.

### B3. Bridge custody, not token transport

Private active state never crosses tool JSON, env, process arguments, mutable
registry/document files or a global `Symbol.for` slot. No exported setter or root
factory exists. The consumer calls the native service; it cannot supply a boolean
or identity record authorizing multi-link reads. The service derives every package
association from its pinned build/launch state on each acquisition.

Producer and consumer must use the same exact native ESM bridge URL from the
installed closure. Adapter peer resolution cannot select it. Pi/Jiti/bundler module
loading may duplicate state: that must deny, not be bridged by a mutable global or
a caller-supplied object. The real selected Pi loader must demonstrate shared native
module custody in a packaging integration test. If that isn't possible, return a
concrete host-supported registration/bridge change for renewed review; this design
does not assert that today's loader already provides it.

## Consumer and per-read contract

1. Existing selected/retained capability and protected logical/resolved path checks
   run before source acquisition. Native identity is provenance, not permission.
2. The bridge accepts a requested path, not a trusted root/source label. Multi-link
   eligibility requires the exact logical physical path with no mutable symlink
   route, under exact README or component-contained docs/examples of the selected
   package. No other package, sibling-prefix or package-root-wide allowance.
3. Pin/revalidate the selected store object, package/document roots, directory chain
   and final opened file. Require root ownership, no write bits within the immutable
   object, regular positive-link file, finite size and unchanged descriptor/path
   association. A stale, renamed, reselected or conflicting root/process rejects.
4. Acquire once using the SR-2 nofollow/nonblock/bounded I/O ordering. Extend only
   this internally bound service's link policy. Never weaken artifact adoption or
   add a source-only flag to readArtifactFile. Reuse pinned descriptor checks and
   defer publication until successful final revalidation/close handling.
5. The multi-link route permits supported **text only**, not media or guessed binary
   decoded as text. Reject supported image signatures, invalid UTF-8 and binary
   control/NUL forms under an explicitly reviewed finite text policy. Filename
   extension alone cannot establish text. Ordinary single-link image behavior stays
   with the existing Pi processing owner. Exact text-eligibility edge rules must be
   reviewed and tested before positive support, not silently invented in code.
6. Valid built-in/configured full-file content scan/redaction still precedes any
   offset/limit/update/spill, including key blocks outside a requested page. Final
   result filtering remains. Callers cannot turn local bytes into a public response.
7. Revalidate process lifetime, immutable selection, original logical/resolved/live
   path association and file metadata immediately before delivery. Abort/unknown/
   cleanup failure produces no partial content or automatic retry. Close all pins.

Missing native producer uses the existing deny-default source policy for ordinary
reads; it does not borrow authority from a peer package. If an authenticated
qualified acquisition starts and fails, **no fallback/retry through another reader**
is allowed. Eligibility absence/unsupported link remains typed unsupported; path
changes/unknown I/O remain unavailable; protected paths, size and invalid content
policy keep their distinct owner codes. No new tool-result fields are proposed.

## Launch and qualification compatibility requirements

Selecting this bootstrap changes which Pi payload executes. Preserve existing
ordinary external-Pi behavior until separately authorized runtime selection. Once
selected, foreground/PTY, background/supervisor, native-addon/version/managed-tool
smoke and runtime-start gate must all agree on the same Pi/Node/bridge identities;
preflighting one PATH Pi and launching a different pinned host is forbidden. Resume
must preserve the originally selected host contract or deny, not silently upgrade
a retained session's capabilities or borrow a fresh producer.

No on-disk launch record or selected config value alone grants bridge custody. A
child process must establish its own bootstrap lifecycle; parent memory/env doesn't
transfer identity. Probe processes do not create authority in the real model session.
The installed trial must identify the actual loaded bridge/reader/host modules,
config and source, not only output version strings.

## Required evidence before enabling and open owner decisions

Reviewer: please accept/reject this producer design against SR-1 and name remaining
findings. Review the SR-2 exact code commit separately. Neither is final acceptance.

Packaging/runtime owner must still choose/approve the concrete pinned Pi/Node
selection, payload layout, bootstrap lifecycle qualification and all affected launch
paths. This document does not supply those absent release bytes or approve a new
package dependency. Their material scope/selection decision remains required.

Implementation/qualification must show:

- Inert **real Nix-built** selected-host/package fixtures exercise actual bootstrap
  execution and the registered guarded tool. Nonroot local mocks are negative/unit
  evidence, not authenticated immutable positive qualification. Do not modify the
  live store or copy previously denied installed documents into a fixture.
- Fixed own closure -> fixed Pi payload -> actual native import -> active bridge ->
  exact document association is traced, including the real Pi extension loader.
- External Pi, different peer import, env/argv/JSON/source-root spoof, stale record,
  alternate main, writable/foreign/sibling root, revoked/exited process, altered
  executable/loader, duplicated bridge state and resumed mismatches all deny.
- No mutable symlink/ancestor/race, owner/mode/link/time/growth/size/FIFO/media,
  invalid-policy or page-offset escape. Include exact before/after revalidation and
  descriptor cleanup/cancellation; retain synchronous cancellation limitations.
- Unchanged strict artifact rejection, native capability/retained guards, complete
  bounded content policy, source inventory and genuine message clarity review pass.
- Exact final candidate independent review and completed required source/CI gates;
  separately authorized installed selection with full README/extensions/example
  guarded reads and genuine foreground human acceptance. PAP-287 remains blocked
  until that access is actually proven; its retained effects are not replayed.

Actual Phase 2b evidence: source-backed design reasoning and document diff/scanner
checks only. No bootstrap implementation or installed experiment was executed.
The source exception remains absent. If the owner/reviewer cannot establish this
concrete build/launch/loader contract, keep SR-1 blocked rather than converting a
self-reported root or opaque handle into proof.
