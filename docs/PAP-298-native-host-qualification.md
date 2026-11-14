# PAP-298 Phase 3b — non-default native host qualification candidate

Parent: `e5a67159661c2022958dbec80277abefe887c5e6`, existing ticket worktree and
feature branch. Scoped dependency/bootstrap qualification approved by Sinh.
**Not a deployment launcher, document-read service, install, runtime selection,
capability, or positive hard-link exception.** All source hard links still deny.

## Concrete executable candidate

`packages/pi-pa/runtime/selected-host-qualification.mjs` and
`nix/selected-pi-qualification.nix` produce a separate immutable qualification
artifact, exposed only through `lib.selectedPiQualificationFor` and its explicit
Nix check. Default pa-platform/ppa outputs, adapter spawn/preflight/start-gate/
supervisor/resume routes, runtime PATH and active configuration are unchanged.
There is no bin alias or normal-argument agent launcher in this artifact.

The build emits literal bootstrap/selection/Pi package/module/Node paths and fixed
versions. The program accepts **no arguments**, root/token/JSON/callback inputs,
preload hook or PI_PACKAGE_DIR override. It verifies initial script/native command,
selected native executable/version and process birth; pins/revalidates selected
file/directory identities, root ownership and nonwrite constraints before importing
the fixed native Pi module. The exact store boundary permits a root-owned non-group/other-writable
or root-owned sticky/no-other-write store; immutable object components require no
write bits. Ordinary mutable directory entry timestamps are not treated as an
identity change. No generic source-file or artifact hard-link policy is changed.

This is an explicit owner-built candidate under the approved pin. A store-looking
path, root metadata or self-hashed selection record by itself remains insufficient
for future production eligibility. Authenticated deployment build/install custody,
actual normal launch integration and per-document proof remain separate work.
No arbitrary Nix output or qualification event can be supplied to the guarded read
tool as a grant. There is no document acquisition API in this candidate.

### Source-qualified main/lifecycle adjustment

The normal release CLI does not await main; it is therefore **not** used as the
lifetime boundary. Instead the bootstrap imports the fixed selected bundle's
public `main` and itself invokes/awaits it with **fixed offline help arguments**.
It compares the actual imported host's VERSION and getPackageDir with the build
selection. A native inline factory is created in that producer's private closure
and passed through the release's `MainOptions.extensionFactories` API. The actual
host loader invokes it, without a path-loaded/Jiti singleton being authority.

Private active state exists only around that actual host invocation, with
shutdown/exit revocation and owned descriptor cleanup. A finite event emitted by
the inline factory is explicitly qualification-only:

```json
{"schema":"pa-selected-pi-qualification/v1","stage":"native-inline-factory","pi":"1.4.0","node":"24.21.0","closureCustody":true,"readExceptionEnabled":false}
```

It is not a tool response/capability or a transferred root identity. The factory
registers no tools and performs no document read. Help terminates the process; the
exit handler revokes/cleans owned state. Print/RPC/interactive/resume lifetimes are
only source-inspected, **not exercised or qualified** by this help test. Actual
CLI setup parity and full PPA launch routes remain unimplemented. The prototype
must not be substituted into a live deployment on these results.

## Actual native checks and an important namespace failure

The fixed artifact evaluated/built at:
`/nix/store/pc1dcxbqcwz9jb22na233qdpvcigmlrf-pa-selected-pi-qualification-1.4.0`.
Its selected Pi/Node paths match the approved proposal. Building an isolated Nix
artifact/check is not an installation or active selection.

1. First `nix build --no-link .#checks.x86_64-linux.selected-pi-host-qualification`
   failed: **5 pass / 1 fail**, exit1. Expected positive host qualification did not
   establish immutable path ownership in the build namespace. Original log:
   `/tmp/pap298-host-qualification-initial.log`.
2. Added fixed finite phase diagnostics and a non-group/other-writable store boundary;
   a second check again failed **5/1**, now identifying immutable path verification.
   Full logs retained, not relabelled as success:
   `/tmp/pap298-host-qualification-second.log` and `-second-full.log`.
3. Native sandbox metadata observation established that `/nix`, `/nix/store`, the
   candidate module and selected Pi root are visible as **uid65534** inside this
   Nix user namespace, while actual host observations are uid0. Log:
   `/tmp/pap298-host-qualification-namespace.log` (still failed positive expectation).
   **Production root-owner checks were NOT relaxed to accept uid65534.**
4. The test driver now explicitly asserts denial when root ownership is unmapped,
   with a distinct case name, not a skipped/pretended positive. Final explicit
   Nix qualification + pin checks exited0; **6 negative namespace/startup cases**
   passed in this build namespace. Log:
   `/tmp/pap298-host-qualification-nix-final.log`. After final comment/inventory
   reconciliation the exact candidate rerun also exited0:
   `/tmp/pap298-host-qualification-nix-candidate.log`.
5. Separately ran the exact immutable artifact in the ordinary host namespace,
   isolated HOME/agent/cache/project dirs and a minimal environment with no inherited
   deployment/provider credentials. **6/6 pass**, including genuine selected Pi
   offline help invoking the native inline factory exactly once, and five startup
   negative cases. Final exact artifact log:
   `/tmp/pap298-host-qualification-host-candidate.log`; earlier runs retained at
   `-host-probe.log` and `-host-final.log`.

The actual host test proves this fixed help/inline-factory path under the observed
root namespace, **not** immutable-document access, a registered PA reader, installed
PPA/bridge provenance, provider behavior, every environment or full host lifecycle.
No prompt/model request was invoked. Offline flags/source control were used; no
claim of a comprehensive network/syscall or native credential-access audit is made.

### Exact final commands

```sh
nix build --no-link --print-build-logs \
  .#checks.x86_64-linux.selected-pi-host-qualification \
  .#checks.x86_64-linux.selected-pi-host-pin

PA_TEST_PI_QUALIFICATION=/nix/store/pc1dcxbqcwz9jb22na233qdpvcigmlrf-pa-selected-pi-qualification-1.4.0 \
PA_TEST_PI_NODE=/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0/bin/node \
PA_TEST_PI_WRONG_NODE=/nix/store/lr2c5f2y7q62pzfrkclgsy5yj31hsn5l-nodejs-22.23.4/bin/node \
NO_COLOR=1 node --test scripts/dev/selected_pi_host_qualification.test.mjs
```

These PA_TEST variables configure only the test driver; the executable never reads
them or accepts their roots. Production-inaccessible fixtures are not being used to
mint a trusted root. Native negative cases cover extra arguments, inherited package
root/Node-option conflicts, calling the export from eval/import, copying this own
first-party bootstrap/record to mutable temp, and a different Node executable.
No denied upstream file was copied/read to execute these tests.

## Source regressions, inventory and messages

All following checks exited0 after the implementation:

- `node --check` on the runtime and test-driver modules.
- `corepack pnpm typecheck`; `corepack pnpm build` (all projects).
- Sequential focused local-source-security/local-read-paths/local-image-type/
  local-source-file/source-content-security/manifest command: **43 pass**, zero
  failures/skips; includes unchanged strict manifest9 and SR-3 probe ordering.
- Sequential requirements-tool-parity/mode-capability-session/pi-extension-composition/
  interactions-catalogue/interactions-discovery command: **16 pass**, no failures/skips.
- `corepack pnpm completions`: no tracked completion diff.

Logs: `/tmp/pap298-host-{typecheck,build,reader-regression,composition,completions}.log`;
final reconciled inventory/composition rerun: `/tmp/pap298-host-composition-candidate.log`.
Full workspace test is not rerun; the historical 600-second incomplete run remains
incomplete. No hosted CI, other-architecture execution, genuine human readability
exercise, full lifecycle or installed guarded-document trial is claimed.

Inventory adds the Nix selection/qualification and native runtime owners as
conservative change guards. No new PA operation/CLI form/capability, artifact
adoption variant or tool result fields are introduced. Qualification output belongs
to an explicit private build/test artifact, not the managed CLI protocol.

New failure category/path is qualification-only startup/contract failure. Fixed
outcome-first guidance states qualification did not complete and no read eligibility
was granted, with one each Condition/Source/Reason/Correction/Resume Action. Reason
uses only a finite internally set phase, never raw exceptions/paths/credentials.
The owner-inspection action has impact none, actor agent/operator, no approval to
ask, preserve evidence/disabled support as prerequisite; retry requires owner
correction and reruns checks without promising success. The pure constructor does
no probes/writes/spawns. All actual denied CLI test paths assert <=2000 UTF-16 units
and label uniqueness in NO_COLOR child output. Unknown native errors remain safely
unclassified contract failure; no private raw error is interpolated. There was no
prior executable qualification message to preserve; existing PPA/OPA streams and
read diagnostics are unchanged. Structural/agent review is not human clarity/UAT.

Local evidence SHA-256 pins (logs under `/tmp/pap298-host-`):

```text
cb428de08ec4baaccf512ebcf9057309917cb204e7cc882f521e3c1165c7a28e  qualification-initial.log
848aa2c9d5bb073482b5d5526937fa898f1f26835a47160c93c9838bbdec00cc  qualification-second.log
296c0683c97d8283b02fd872a6f2862052081a26c42b5af4a9f883f60feffe34  qualification-namespace.log
c0ed662577e25b7fdf789dea42a31e63258fb031f3cdeb1d34c3164f90cfeddd  qualification-nix-candidate.log
493b0aa5c75dfd63cc4ee8f6ae91546c6d22417c9cb7f35ef5be84d210ba2317  qualification-host-candidate.log
871a59224a6d37abe6a9e9d0d47d2e66c460b398fe093160bc461d71d34296ff  reader-regression.log
588d9139dac8ec89a91f4b23c43cf3ff2affe7c96a64418ca8e9c5c960bbf3ac  composition-candidate.log
```

## Required independent disposition before next integration

Return this exact code, SR-3 source repair and the concrete main/inline-factory
adjustment for independent review. SR-1's positive enabling gate remains OPEN.
The next code owner must still supply authenticated selected build/launch custody,
real CLI setup and all foreground/background/probe/resume routes, actual retained
admission, finite text eligibility, per-document immutable traversal and complete
content/result security. Then require positive/negative real guarded-tool tests,
completed broad regression/CI and exact final-candidate review. Installation,
runtime selection and human acceptance remain separately authorized. PAP-287/
PAPC-064 access prerequisites and retained effects are untouched.
