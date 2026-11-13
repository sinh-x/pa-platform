# PAP-298 Phase 4 — disabled integration prerequisites

Parent: `ddafa22f7311a81b264fde744474c03c1ef72d90`. Implementer deployment
`d-b271d5`, existing ticket worktree/feature branch. Sinh explicitly selected
**Proceed with disabled integration**: the approved Pi1.4.0/Node24.21.0 tuple,
no installation, active selection, downstream resumption or unreviewed hard-link
grant. The independent review of ddafa22 was read completely and its SHA-256
verified: `dc60a2bb9fc6af1620b9e88dcced8fac832487e0aae155e75fe5d73bf6d7d67f`.
SR-1 remains HIGH/OPEN. This phase addresses prerequisites, not the whole producer.

## Phase 4a — pre-Node entry

`packages/pi-pa/runtime/selected-host-entry.c` is statically linked into the
**non-default qualification artifact only** as `bin/qualify-selected-pi`.
No `pi` alias, package default, PPA PATH, spawn/preflight/background/start-gate/
child/resume route or runtime configuration selects it. It accepts no arguments,
requires its literal initial executable/argv identity, rejects nonempty inherited
Node/dynamic-loader/deferred-startup environment namespaces, and execs only the
literal selected Node and fixed offline-help bootstrap. No root, grant, JSON,
callback or target parameter exists. No document service/tool is added.

This addresses the narrow problem that JavaScript sees NODE_OPTIONS **after**
Node has already processed preloads. The static entry itself has no ELF interpreter;
actual inert --require/--import fixtures cannot run their marker-writing preload
before rejection. Its fixed messages do not echo arbitrary environment values.
Direct Node invocation of the old qualification bootstrap remains qualification
only and is not a provenance grant. This does not authenticate own installed
build custody, protect a malicious launcher/parent, or qualify production launch
routes. Future production entry must reuse a reviewed pre-exec boundary rather
than assume the JavaScript conflict check alone provides one.

Actual checks (all exit0, no skipped/cancelled tests):

```sh
nix build --offline --no-write-lock-file --no-link --print-build-logs \
 .#checks.x86_64-linux.selected-pi-host-qualification

PA_TEST_PI_QUALIFICATION=/nix/store/rnmlymyz3ikbxhc323gsf6r5a2jk09g6-pa-selected-pi-qualification-1.4.0 \
PA_TEST_PI_NODE=/nix/store/j1j9b0w3mhpccdli73ycj5w7nf6fkzqz-nodejs-24.21.0/bin/node \
PA_TEST_PI_WRONG_NODE=/nix/store/lr2c5f2y7q62pzfrkclgsy5yj31hsn5l-nodejs-22.23.4/bin/node \
NO_COLOR=1 node --test scripts/dev/selected_pi_host_qualification.test.mjs \
 scripts/dev/selected_pi_host_entry.test.mjs

NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
 packages/pa-core/src/__tests__/interactions-catalogue.test.ts \
 packages/pa-core/src/__tests__/interactions-discovery.test.ts
```

Fresh Nix build/check: **10/10**, all qualification-positive cases correctly assert
**denial** for unmapped uid65534 in the build namespace. Separate ordinary-host
execution: **10/10**, including actual selected Pi offline help through the static
entry and the direct qualifier. Inventory: **11/11**. `readelf -l` showed no INTERP
or requested interpreter for the built entry. C build uses warnings-as-errors.
No first-run failure occurred for these commands; historical failures/incomplete
workspace tests remain retained, not superseded by these focused passes.

Evidence logs/digests:

```text
13597b58e09b4bff755b08a864596fbb8dfb21776f744005e9a99df42caa764e /tmp/pap298-entry-nix-initial.log
a716405aa0276fac03d54bfc21c18b31533af2c505f82afe117b6618ae542382 /tmp/pap298-entry-host.log
e0bbe5e1a53df0349817596cc6b3c0478b5b1e96fc507c3986c4737e2678d7c3 /tmp/pap298-entry-inventory.log
```

Messages: new qualification-only failure path (`SELECTED_HOST_ENTRY`), not a new
PPA/OPA CLI command. Before: no pre-Node owned diagnostic; Node preloads could run
before the JavaScript conflict check. After: “Selected-host qualification did not
start.” followed by one each Condition/Source/Reason/Correction/Resume Action.
The fixed pure constructor exposes no private exception/input; actual negative
process results assert exit1/stderr, empty stdout, <=2000 UTF-16 units and label
uniqueness. Guidance asks owner inspection (impact none, actor agent/operator,
no approval merely to ask, preserve result/disabled support), conditional retry,
no installation/access promise. Source inventory adds the entry owner and renews
the changed Nix owner after semantic inspection. Human clarity/UAT is not run.

## Phase 4b — registered reader lifetime

`registerPiSessionModules` now owns a private AbortController for each registration.
It installs revocation before module shutdown steps, combines the native lifetime
signal with each caller read signal, suppresses late read progress, and checks
revocation after filtering both returned and thrown delegated-read outcomes.
Actual `createSecureLocalReadTool` observes this signal while descriptors are
pinned and before final delivery; its existing finally closes them. Shutdown
still waits for tracked in-flight accesses before registry close. Other tools,
registry tracking semantics, selected/retained admission, direct tool signals,
result fields and read failure wording are unchanged. No identity setter,
trusted-root argument, provenance flag or test override is introduced.

This is a production **revocation prerequisite**, not a selected-host producer
connection. A replacement session gets its own lifetime; it cannot reactivate an
old registered reader. A caller abort cancels only its call, not the session.
Synchronous reads cannot observe newly dispatched external events until JavaScript
runs them; microtask revocation before async formatting/delivery is covered, not
hostile-same-UID isolation or a persistent read-operation journal.

The new actual-reader baseline test was run BEFORE the repair:

```sh
NO_COLOR=1 node --import=tsx --test --test-name-pattern='registered read lifetime' \
 packages/pi-pa/src/__tests__/local-source-security.test.ts
```

**Exit1, 0 pass/1 fail**: read acquired bytes, queued shutdown during the async
boundary, but returned ordinary text (`isError` undefined, expected true). Original
log retained. After repair, expanded source command **46/46 pass** (unchanged
manifest9 included), composition/admission/native-host **37/37 pass**, workspace
`corepack pnpm typecheck` exit0. New cases cover actual acquired-byte revocation
and descriptor cleanup; all five reload/new/resume/fork/quit reasons; a delegated
reader ignoring cancellation, including late thrown body/update; late calls before
delegation; independent replacement lifetime; and caller cancellation without
session revocation. These are inert source-host fixtures, not selected Pi1.4.0
registered-consumer qualification.

Exact focused commands:

```sh
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
 packages/pi-pa/src/__tests__/local-source-security.test.ts \
 packages/pi-pa/src/__tests__/local-read-paths.test.ts \
 packages/pi-pa/src/__tests__/local-image-type.test.ts \
 packages/pa-core/src/__tests__/local-source-file.test.ts \
 packages/pa-core/src/__tests__/source-content-security.test.ts \
 packages/pa-core/src/artifacts/__tests__/manifest.test.ts
NO_COLOR=1 node --import=tsx --test --test-concurrency=1 \
 packages/pi-pa/src/__tests__/requirements-tool-parity.test.ts \
 packages/pi-pa/src/__tests__/mode-capability-session.test.ts \
 packages/pi-pa/src/__tests__/pi-extension-composition.test.ts \
 packages/pi-pa/src/__tests__/pi-native-host.test.ts \
 packages/pa-core/src/__tests__/interactions-catalogue.test.ts \
 packages/pa-core/src/__tests__/interactions-discovery.test.ts
```

```text
e9254bbf4c57c49a795f9d8f0ec98c1b64e8a501bf4e02341d2ab837e538e9cc /tmp/pap298-lifetime-baseline.log
c8480d8618867793e7680024ee18fc9760d173b1df1a2e9e0601d18674e33dda /tmp/pap298-lifetime-focused.log
884dfa2b8684a5e53c8f0fb81b10084fa0d78d5f85a4ad269c6cb9aca28f8399 /tmp/pap298-lifetime-typecheck.log
0b0df169ea0bfe38dedfef08e9ff39041d41db6ea849148f6e45f32fc3a61e75 /tmp/pap298-lifetime-composition.log
```

No new wording: the existing typed LOCAL_SOURCE_UNAVAILABLE/result-withheld
contract now covers actual native revocation as well. Baseline late success becomes
a truthful unavailable result; unknown underlying mutable effects are not called
absent. Module source inventory renewed after checking affected consumers.

## Remaining enabling boundary

Configured installed README/extensions guarded reads still returned
LOCAL_SOURCE_UNAVAILABLE in this deployment; no alternate reader/copy was used.
No new Pi API implementation is inferred from those denied documents. Existing
reviewed fixed-help API use is unchanged. Production setup/lifecycle and release
reader API parity, authenticated installed build/launch custody, common launch/
resume tuple, private actual registered reader service and finite immutable
UTF-8/text traversal/content checks remain unimplemented/unqualified. ALL source
hard links still deny and strict artifact owners/tests remain unchanged.

Independent exact-candidate review, completed broad regression/hosted CI, separate
installed selection/provenance/normal complete docs reads and human acceptance
remain required. PAP-287/PAPC-064 stay blocked; status/lease/retained effects stay
unchanged. No full ticket or SR-1 completion is claimed.
