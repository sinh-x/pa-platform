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
No normal tool calls the new primitive. Phase5a initially inherited the old
wildcard public barrel export; Phase5b corrects that accidental exposure to an
explicit ordinary-only export. The specialized entry is internal, not a public
permission/grant API.

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
HT/LF/CR, DEL/C1 controls, or recognized PNG/JPEG/GIF/BMP/WebP headers. GIF/BM
prefix checks are deliberately conservative so the shared image classifier cannot
promote a multi-link payload into an attachment; exact eligibility needs review. Empty text,
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

## Phase 5b — real pinned host / bound reader qualification

`bindLocalReadTool` extracts the existing whole-file admission/scan/projection/
pagination implementation. The ordinary public `createSecureLocalReadTool()` has
**no new parameters** and still fixes its single-link acquirer. Only the private
fixed-build qualification producer composes a different acquirer; the constructor
is not an origin grant and is not selectable by tool JSON, config or environment.
The new core link route decides on its opened descriptor. Single-link aliases and
images retain ordinary mechanics; only multi-link files require exact spelling,
immutable ancestry and the finite text policy.

The separate `selected-pi-document-qualification.nix` rebuilds the approved pinned
Pi1.4.0 input with freshly authored inert README/docs/examples, including explicit
hard links and binary/symlink negatives. No denied installed documentation was
copied into the fixture. Only these new inert texts are read by the qualifier.
Its actual public main/native loader invokes the private inline factory, which
uses **that host's** createReadToolDefinition and registers the shared guarded
reader through its actual Pi API. This is actual Pi registration, NOT a live
PPA selected/retained admission or production transport trial.

### Producer and publication custody

The qualification-only C variant is a static supervisor, not a normal `pi` alias.
It accepts no args and the same six-key offline environment. Before Node executes,
it walks/pins safe immutable initial code paths with nofollow/nonblock descriptors,
verifies root ownership/modes and entry inode against its executing inode, and
execs the build-resolved **canonical** selected Node binary. It forks only this
fixed child and remains its parent until exit. Parent death signals the child;
ordinary signals forward. The JS producer revalidates kernel parent executable,
command/birth and child incarnation, own code/record/package/module/Node pins,
including `/`, and actual imported host version/package root before activation,
every read and publication. No caller-mintable token/fd/root record replaces this
association. Root/Nix and trusted own-build selection are assumptions, not hostile
same-UID isolation or independent installed-signature authentication.

The private acquirer is constructed only around the producer's actual selected
main/factory lifetime. It selects the scoped route before acquisition; failure of
that route never retries via another reader. The fixed native publisher retains
source descriptors **through the registered tool's promise hops**, revalidates,
attempts all closes, checks cancellation and writes to its actual native sink
without another await. A test aborts after the tool result arrives but before
that sink and observes withheld output. Remaining leases/pins revoke/close on
main failure/settlement/shutdown/process exit. This demonstrates the owned fixed
qualification sink only: **O-1 remains open for ordinary production PPA transport**.
It does not silently redefine publication as the existing inner checkpoint.

No foreground/background/probe/start-gate/child/resume/default/PATH route selects
this artifact. In particular the new supervisor changes parent/child PID topology;
existing protected admission/start-gate PID contracts must be integrated and
reviewed, not assumed compatible. Real CLI setup, full session lifetimes, native
registry ABI/admission and production environment are not qualified by offline help.
Native output records are qualification evidence, never permission/readiness.

### Actual checks and evidence

- Shared source/descriptor/content/read/path/image/unchanged manifest: **50/50**,
  including a public-barrel isolation regression and ambiguous GIF-prefix denial.
- Composition/admission/native-host/inventory: **38/38**; ordinary guard unchanged.
- Immutable Nix **mechanics-only** fixture through the shared guarded formatter:
  **4 groups pass** (README/example positive, redaction before page, binary/symlink/
  outside/oversize denial, cancellation/revocation/mutable negatives). Its test
  binding is explicitly NOT actual selected-host identity or a production seam.
- Real selected Pi1.4.0/Node24.21.0 native qualifier: **4 groups pass**, including
  **10 guarded read/publication cases** inside the actual native inline factory;
  direct Node, args/environment/root claims and copied supervisor negatives.
- Workspace typecheck/build/completions exit0; no tracked completion diff.
- Existing fixed-help static-entry Nix regression **11/11** under the unmapped
  build namespace: those positive-host cases are truthful denials, not positives.
- No whole-workspace test/CI/installed/human acceptance pass is claimed.

Exact current immutable document artifact:
`/nix/store/yv6w1mcrr318hk6361lxqdsr2rkfbf4i-pa-selected-pi-document-qualification-1.4.0`.
It uses a fixed build-only foundation at
`/nix/store/3l2bikj361zsqn3draxgbpxhzxfk1phq-pa-platform-0.1.163` (built successfully
from the Phase5a source; used for its pinned esbuild/js-yaml dependencies, not as a
runtime root/permission override). The library defaults to building its foundation;
this explicitly supplied immutable build dependency avoided repeated native-addon
rebuilds during qualification. No foundation/fixture variable is read by the
resulting producer.

```sh
nix eval --impure --offline --no-write-lock-file --raw \
 .#lib.selectedPiDocumentQualificationFor --apply \
 'f: (f "x86_64-linux" { foundation = builtins.storePath "/nix/store/3l2bikj361zsqn3draxgbpxhzxfk1phq-pa-platform-0.1.163"; }).drvPath'
# Realize the returned exact derivation, without installing/selecting it:
nix-store --realise /nix/store/1la82kwwscxglx3p5dxvxrxxqg517y70-pa-selected-pi-document-qualification-1.4.0.drv
PA_TEST_DOCUMENT_QUALIFICATION=/nix/store/yv6w1mcrr318hk6361lxqdsr2rkfbf4i-pa-selected-pi-document-qualification-1.4.0 \
PA_TEST_PI_NODE=/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0/bin/node \
NO_COLOR=1 node --test scripts/dev/selected_pi_document_qualification.test.mjs

# Separate mechanics-only lane; core dist must first be built:
PA_TEST_IMMUTABLE_DOCUMENT_FIXTURE=/nix/store/sk6n993a0jyl6n2sq5w80w96d3cvw2mh-pa-inert-immutable-document-mechanics \
NO_COLOR=1 node --import=tsx --test scripts/dev/selected_document_mechanics.test.mts
```

Original failures retained: initial pure eval rejected build-only storePath (needs
--impure); a stale pre-change output path was corrected using the successful own
build's returned derivation/output metadata; first document build **exit127**
because esbuild's wrapper had no Node on builder PATH. Added the fixed selected
Node as a build input; subsequent builds/native runs pass. The inert Pi rebuild
normally substituted roughly915MiB of exact pinned build inputs from cache.nixos.org;
this was dependency realization, not installation or alternate denied-doc retrieval.
All first/second/final/current/candidate build and native logs remain under
`/tmp/pap298-document-qualification-*`; the **candidate** build/native logs are
code evidence before the final fixture cleanup. The staged scanner then flagged
the synthetic API-key-shaped assignments: the attempted commit was blocked, not
made. Removed those assignments and used explicitly invalid instructional key
blocks instead, improving the test to cover a header outside the requested body
page (offset3). No scanner exception, suppression or policy change was used.
The final native logs are `/tmp/pap298-document-qualification-{build,native}-reviewed-fixture.log`;
final source/mechanics logs are `/tmp/pap298-hardlink-candidate-focused.log` and
`/tmp/pap298-document-mechanics-reviewed.log`. The word reviewed in these filenames
is a fixture label, NOT independent review or approval.

Other exact logs: `/tmp/pap298-hardlink-{bound-tests,bound-composition,bound-typecheck,
workspace-typecheck,workspace-build,completions,entry-regression}.log` and
`/tmp/pap298-document-mechanics-tests-initial.log`. The separate whole-package
foundation build log/exit are `/tmp/pap298-hardlink-package-build.{log,exit}`.
Historical600s and intentionally interrupted143 full workspace runs stay incomplete.

Messages: unsupported-file reason now covers finite text eligibility; new fixed
qualification startup failure includes only an internal finite phase, never private
exceptions/paths. Actual negative native tests assert <=2000 UTF-16 units, one each
five labels and no content records. Supervision's rare wait-status failure has a
separate fixed **outcome unknown** diagnostic (child started, possible earlier
output, inspect existing process, no blind retry), rather than falsely claiming
nothing executed. That rare wait-status error was NOT fault-injected. Human clarity,
full lifecycle/kill/cleanup fault matrix and exact production API/resolver parity
beyond these fixed ASCII paths remain unproven.

## Required remaining work

Private actual selected-host producer/consumer connection and immutable positive
fixtures; O-1 actual publication-boundary fencing or explicit requirements-owner
disposition (not silently changed); all real production launch/setup/resume routes,
exact independent candidate review, broad regression/CI, separately authorized
installed reader/provenance/complete normal docs reads and genuine human acceptance.
No installed hard-link support or downstream PAP-287/PAPC-064 access is claimed.
