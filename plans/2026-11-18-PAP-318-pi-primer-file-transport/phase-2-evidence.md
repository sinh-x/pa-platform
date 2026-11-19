# Phase 2 — bounded prompt transport

Implemented uniform private byte snapshots (16 MiB explicit limit), bounded integrity references and in-process expansion before the unchanged Pi CLI parser. Selected-host expansion occurs after native caller/source/argument/incarnation checks. Non-selected Node CLI expansion uses a fixed launch-only preload after the foreground gate; no provider/model/tool/session flags are replaced. Background reconstruction and protected-review composition share this transport. Analyst route admission was not widened.

Files: packages/pi-pa/src/{prompt-transport,prompt-preload,adapter}.ts; packages/pi-pa/runtime/selected-pi-host.mjs; flake.nix; affected transport/Analyst-adapter/protected-review tests.

## Actual checks

- Initial Pi-only build failed because pa-core generated exports were stale. Building pa-core first repaired that prerequisite; both package builds then passed. This was not a source-code workaround.
- Initial multi-file test invocation timed out at 120 seconds; its incomplete output was not treated as a pass.
- Subsequent sequential adapter/background/runtime-gate/selected-launch/transport suites: 108 passed, zero failed (139.9 s), before review fixes.
- Independent read-only code-reviewer review identified public-path unlink races, startup-exception lifecycle gaps, two stale retained tests, and missing boundary coverage. The review did not claim installed verification.
- Repaired cleanup with atomic private claim/identity verification, retained mismatched evidence, post-unlink link-count verification and explicit uncertain-process reporting. Known no-child setup failures remove unused inputs; uncertain PTY outcomes retain them and fail truthfully. Retained resource and protected-authorization assertions now inspect actual child-consumed input rather than a bounded OS reference.
- After fixes: Pi package build passed. `corepack pnpm --filter @pa-platform/pi-pa exec tsx --test --test-concurrency=1 --test-name-pattern 'PAP-318|PAP-316|protected reviewer input' src/__tests__/pi-primer-transport.test.ts src/__tests__/analyst-identity-adapter.test.ts src/__tests__/pi-deploy.test.ts`: 28 passed, zero failed.

Real disposable checks include the preserved 635831-byte E2BIG baseline; exact count/digest across actual shared spawn and supported resume; real foreground inert gate retaining PID/start incarnation; actual child consumption for empty, small, BOM/Unicode/CRLF/trailing-newline/path-space/quote inputs and the 16 MiB boundary; over-limit/invalid/unsafe/aliased/mutated/replaced inputs; atomic-claim race injection; and incident-sized protected-review child input with authorization exactly once in its protected location. No provider/live ticket was used.

## Touched messages

Categories: prompt input blocker, known startup failure, incomplete cleanup; selected-host failure now names prompt validation as a possible typed cause. Original incident: `execvp(3) failed.: Argument list too long` / `Pi exited with code 1`. New input example: `Pi initial prompt could not be delivered safely.` followed by the five fixed fields and PI_PROMPT_INPUT. New cleanup example: `Pi prompt cleanup is incomplete.` followed by the five fields and PI_PROMPT_CLEANUP; it does not suggest a replacement run. Structural input-diagnostic tests passed (exactly five labels, <=2000 UTF-16 units). Public text contains no file bodies or arbitrary exception interpolation. Existing status/exit/stream shapes remain unchanged. Independent human readability/UAT is not inferred.

## Limits

No hostile-same-uid isolation is claimed. Mismatched private claims and uncertain process inputs deliberately remain for their original owner. Exact selected installed-host execution, installed Pi parser provenance, hosted CI, normal foreground provider behavior and human UAT remain unverified. The selected immutable host source now pins the prompt module, but a source build does not establish installed adoption. Integrated suites and review of the final combined candidate belong to phase 4. Production PAPC, d-20c9b0 and live workflow retries remain untouched.
