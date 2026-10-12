# Isolated historical-shape copy (not authority)

### Full Validation Matrix

Matrix Source: agent-teams/requirements/artifacts/fixture-pap-240-legacy.md

Authority and owner:
- This bounded section is the sole full-validation authority. Hash raw UTF-8 bytes from this unique heading to immediately before the next level-1-to-3 heading, including all internal whitespace; do not normalize bytes.
- One independent requirements/review-auto deployment consumes one Review Authorization ID formatted as review-auth: followed by a lowercase canonical UUIDv4. Before spawn, the trusted orchestrator persists a durable launch intent binding FIX-237, feature/FIX-237-opt-in-axi-packaging, one 40-lowercase-hex Feature SHA, this Matrix Source, the 64-lowercase-hex Matrix Authority SHA-256, Matrix Approval Evidence, and authorization. Objective, report, and registry must agree exactly. At most one deployment consumes the authorization; any active review for this ticket/branch blocks another launch across all SHAs and matrix revisions.
- Admission requires HEAD == Feature SHA, exact raw-byte digest agreement with the header and durable Sinh approval, and an authenticated review checkout before any project command. Missing, stale, malformed, duplicate, conflicting, or unapproved evidence blocks launch. Project guides cannot override, append to, delete from, or conflict with this matrix.

Prerequisites:
- Execute from the authenticated FIX-237 feature checkout selected by the trusted launcher, never the canonical analysis root. Candidate implementation includes the new AXI smoke script and all declared tests/derivations.
- x86_64-linux NixOS host; Nix with nix-command/flakes and working sandbox; flake.lock unchanged except explicitly approved packaging inputs. Build fetches may access only integrity-pinned sources; runtime tests must not bootstrap packages.
- Node >=22.19 from the flake-locked nodejs_22 derivation, corepack, pnpm 10.28.0, bash, git, Python 3, and fish available. Workspace dependencies and reviewed vendor submodules are materialized at their lockfile/gitlink revisions before review.
- Pi 0.84.4 or later available as pi, matching the existing installed-output smoke's native-host expectations. Existing script's default Pi Node expectation is v24.19.0; an incompatible host blocks rather than silently changing that expectation.
- Operator Chrome executable /isolated/profile/bin/google-chrome-stable exists and supports headless local fixture tests. Discovery observed Google Chrome 152.0.7977.64; record the exact review-time Chrome version and resolved executable/store path. Chrome is an operator prerequisite, not a reproducible FIX-237 dependency or browser provisioning step.
- No real GitHub or provider credentials, authenticated vendor endpoints, personal browser profile, or PAPC-040 checkout is required. GitHub/quota policy checks use synthetic credentials and injected local fixtures; production quota endpoints cannot be overridden through public flags.

Environment:
- PA_DEPLOYMENT_ID and PA_DEPLOYMENT_DIR are the exact trusted review launch values; evidence lives under $PA_DEPLOYMENT_DIR/evidence.
- PA_AXI_CHROME_EXECUTABLE=/isolated/profile/bin/google-chrome-stable
- PA_AXI_QUOTA_CONSENT is unset in the outer review environment; fixture tests create deployment-bound synthetic consent/profile inputs in their temporary directory.
- PAP167_REAL_PI, PAP183_EXPECTED_PI_NODE_VERSION, PAP183_SMOKE_CAPTURE_FIXTURE, and PAP183_SMOKE_TEST_FIXTURES are unset; use production installed-output checks, not success fixtures.
- Never export real GH_TOKEN, GITHUB_TOKEN, provider API keys, or browser attach/shared-endpoint overrides into smoke subprocesses; scripts explicitly scrub credential variables and use temporary HOME/XDG roots.

Commands (run in this exact order; each numbered entry is one command):
1. `corepack pnpm typecheck`
2. `corepack pnpm build`
3. `corepack pnpm test`
4. `corepack pnpm completions`
5. `corepack pnpm secrets:scan`
6. `nix flake check '.?submodules=1' --no-build`
7. `bash scripts/nix-store-output-smoke.sh --log-file "$PA_DEPLOYMENT_DIR/evidence/pap-240-pa-regression.log"`
8. `bash scripts/axi-nix-output-smoke.sh --system x86_64-linux --eval-system aarch64-linux --all-selections --chrome /isolated/profile/bin/google-chrome-stable --log-file "$PA_DEPLOYMENT_DIR/evidence/pap-240-axi-smoke.log"`

Required outputs/artifacts:
- Numbered command stdout/stderr, exit status, start/end time, candidate SHA, matrix digest, approval reference, and authorization recorded by review under $PA_DEPLOYMENT_DIR/evidence; no raw credential or identity output.
- pap-240-pa-regression.log proves existing four Pi-plugin native outputs, both-system evaluation, adapter/native-addon smoke, and tools=8/8 remain passing.
- pap-240-axi-smoke.log and pap-240-axi-smoke.json in the same evidence directory record all 8 native AXI outputs, 16 AXI/system evaluations, aarch64 dry-runs, strict-type failures, default alias/overlay behavior, exact pins/locks/licenses, PPA-added PATH membership, unchanged other-adapter prefixes, local browser concurrency/collision/teardown timings, synthetic quota consent/redaction/stale/unknown checks, and zero forbidden side effects. Record resolved store paths and Chrome version. The script exits nonzero for any missing case or failed assertion.
- Unit/integration tests explicitly cover all four existing Pi-plugin selections with AXI defaults and AXI-enabled launch behavior without changing global skill/extension discovery.

Pass Criteria:
- Commands Total: 8. Commands Passed must equal 8: 100% completion, every exit status 0 at the exact Feature SHA; no skip, success fixture, substituted command, or partial build counts as passing.
- 8/8 native AXI selections build and execute; 16/16 two-system selections evaluate; non-native builds are dry-run only and must not be reported as native execution.
- Browser readiness <=30000 ms, idle bound 300000 ms, deployment-end cleanup <=10000 ms; simultaneous deployment isolation passes and foreign processes/profiles are unchanged.
- Consent denial causes zero credential reads and zero provider requests; delegated refresh, inference probes, runtime package downloads, MCP usage telemetry, and automatic routing each have count 0. All redaction sentinel assertions pass.
- Critical = 0 and Major = 0. Every accepted/deferred Minor finding includes its rationale and explicit disposition in the independent report. Required logs and JSON are present, internally consistent, and non-secret.
- Phase/change-focused implementation checks are separate from this matrix and do not authorize builder/implement to execute full validation. CI, UAT, merge, ticket, and approval gates remain required.

## After Matrix

Fixture only. No historical migration or approval.
