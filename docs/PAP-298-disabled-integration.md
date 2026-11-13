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
