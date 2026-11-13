# PAP-298 — selected immutable document reader candidate

Continuation from `3df6b79f6dff8819a4df4429b8282fc9d481b593` in the existing
slot9 ticket worktree. Sinh requested proceeding with hard-link implementation.
No installation, active runtime switch, general Nix exception or final acceptance
is implied. The full d-583f84 review was read and its published SHA-256 verified
`b7ad255bd9d8f9310f56f9fcd8c2ffe3b97b3e7834ea49439f32b40efe7a4ebf`.
SR-1 and O-1 remain open enabling obligations; scoped SR-4/reentry resolutions
are retained. No denied installed/source document is retrieved another way.

## Phase 5a — acquisition mechanics and finite text policy

The ordinary `acquireLocalSourceFile` still requires exactly one link. Its pinned
bounded acquisition implementation is shared privately with the new internal
`acquireSelectedPiDocument` ingress. Artifact/manifest/review-asset owners and
strict artifact test assertions are untouched. No caller tool argument, runtime
config/env root, global grant or artifact `allowHardlinks` option is added.
The new primitive is not exported from pa-core's public index and no normal tool
calls it yet.

`SelectedPiDocumentBinding` is **mechanics input, not provenance**. Only a private
fixed-build producer that executes the selected host may supply it to a guarded
consumer; a callback/root object alone cannot authenticate that producer. A future
consumer must establish that custody independently. Unit fixtures do not mint it.

Selected mechanics require exact normalized logical=resolved spelling, finite
component-safe README.md/docs/examples scope, no symlink component, root-owned
nonwritable object/file/directory metadata, pinned descriptor/live-path association,
positive links, regular bounded file, nofollow/nonblock acquisition, stable size/
owner/mode/link/times and producer lifetime before and after ingress/delivery.
The exact store parent retains the reviewed sticky/no-other-write semantics;
ordinary mutable ancestor entry timestamps are not identity. Every owned descriptor
is closed on failure and final cleanup failure suppresses success.

Complete multi-link bytes must decode with fatal UTF-8 and contain no C0 except
HT/LF/CR, DEL/C1 controls, or recognized PNG/JPEG/GIF/BMP/WebP headers. Empty text,
Unicode, source examples and UTF-8 BOM are supported. Extension alone is not text
proof. Full-file sensitive content projection remains the consumer's mandatory
next step before pagination/results; immutable provenance never exempts it.

Touched failure category/path: typed LOCAL_SOURCE_UNSUPPORTED_FILE, through the
existing five-label SourceContentSecurityError/local failure propagation. Before
reason mentioned only regular/single-link policy. After reason also identifies
finite selected-document text policy, without raw errors/paths or new fields.
Existing outcome, next action, <=2000-unit structure, stream/result/admission
contracts are preserved. Structural/agent inspection is not human clarity/UAT.

Actual checks (exit0): core prerequisite build; focused primitive/content/source/
reader/path/image/unchanged manifest tests **49/49**; source inventory **11/11**;
adapter `corepack pnpm --filter @pa-platform/pi-pa exec tsc -p tsconfig.json --noEmit`.
Logs `/tmp/pap298-hardlink-core-build.log`, `pap298-hardlink-policy-tests.log`,
`pap298-hardlink-policy-inventory.log`, `pap298-hardlink-policy-typecheck.log`.
New scope/UTF-8/control/image tests and mutable/forged-binding negatives pass.
This phase has no authenticated immutable positive or production enabling claim;
actual Nix-built guarded positive/negative qualification is the next phase.

## Required remaining work

Private actual selected-host producer/consumer connection and immutable positive
fixtures; O-1 actual publication-boundary fencing or explicit requirements-owner
disposition (not silently changed); all real production launch/setup/resume routes,
exact independent candidate review, broad regression/CI, separately authorized
installed reader/provenance/complete normal docs reads and genuine human acceptance.
No installed hard-link support or downstream PAP-287/PAPC-064 access is claimed.
