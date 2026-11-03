# PAP-273 phase 5 — native catalogue consumption

Source implementation following operator-owner commit `98592e7`. Not installed
qualification, human adoption, independent acceptance or universal toolchain support.

## Source selection and sticky evidence

`ProjectCommandContract` now observes the one native repository approval owner.
A local candidate without valid native approval still rejects before confinement
or command admission. Legacy/local and linked-source conflicts remain closed.
Deleting a previously adopted candidate, adding legacy registration, revoking an
approval, resetting credentials, changing catalogue bytes or changing ignored/
untracked status cannot restore legacy execution. No caller approved flag exists.

The retained command registration identity is unchanged for legacy config-pinned
contracts. A local catalogue instead binds its raw digest AND exact native approval
record digest. Native execution descriptors retain this identity; reapproval,
revocation, reset or changed source cannot upgrade a running lineage. Before
another program is generated, the current source, native approval, catalogue,
prerequisite bytes/modes and custody checks are reobserved.

## Task-required checks, not all catalogue entries

Static catalogue inspection returns the catalogue as data without probing unused
executables or their prerequisites. Dispatch resolution requires a nonempty exact
required-command list. Production native execution derives that list from the
persisted structured workflow's approved subject/matrix; it is NOT the agent's
phase-plan subset or a caller-supplied grant. A local catalogue without an eligible
structured task authority cannot fall back to historical paragraph permission.

`authorizePiStructuredWork` requires local-catalogue phase plans to include EVERY
approved task-required check in its approved order; aliases resolve to exact
command spelling. Outsiders, duplicates and dropped required checks reject.
`selectCatalogueTaskChecks` then chooses exactly those catalogue entries. Unused
entries, executables and prerequisite files are not required to run the task.
The existing native source-result owner independently reconstructs this exact set
and registration identity when consuming phase/commit/check evidence.

Legacy `project-command-contract/v1` remains all-contract-checks semantics with
unchanged registration digests. Local semantics use the separately versioned
`project-command-catalogue/v1`, not a reinterpretation of old approvals/contracts.

Selected commands use the SAME root-owned immutable executable validation,
bubblewrap capability probe, namespaces, read-only explicit project input mounts,
isolated temporary writes, literal argv/environment, prerequisite provenance,
output/time limits and real native process/result owners. No shell, Nix/Android
executor expansion, mutable executable exception or confinement fallback was added.
A statically observed catalogue is never proof a toolchain can run on that host.

## Verification ownership

Four new mandatory native cases cover actual confined selected-command dispatch
with an unavailable unused catalogue member; absent/empty/duplicate/outsider task
scope and unapproved candidates; revocation/reset/reapproval/drift; prerequisite
changes and linked administrative substitution. They use real disposable native
approval records with an explicitly synthetic operator fixture, not actual human
approval. Combined affected native command/source/startup entry: 37 passed, zero
failures/skips. A separate complete full native workflow run also passed 35/35,
zero failures/skips (120.8 seconds); the earlier 240-second combined timeout stays
historically incomplete. Workspace typecheck and all 25 script/inventory/verifier
tests passed. Legacy mandatory cases remain unconditional.

The new native file has an explicit manual/native lane owner; code-only CI cannot
count it as passed or skip it silently. The full/installed verifier requires the
file and its case group (28 qualification rows). Separate full-workflow, hosted,
exact installed/fresh-host, independent review and real operator UAT/adoption are
still required. Source-host dependency injection exists only for trusted native
fixtures, never in public tool/CLI inputs.
