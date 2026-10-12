# Isolated historical-shape copy (not authority)

### Full Validation Matrix

Matrix Source: requirements:agent-teams/requirements/artifacts/fixture-dg-438-legacy.md

Authority: hash the raw UTF-8 bytes from this unique heading to immediately before the next level-1, level-2, or level-3 Markdown heading. Include the heading and all internal whitespace; perform no normalization. The durable Sinh approval comment must name this source and digest. This document alone owns the matrix; project guides cannot add, remove, or override commands.

Execution owner: one independent requirements/review-auto deployment. Before spawn the trusted orchestrator persists a durable launch intent binding FIX-237, feature/FIX-237-delivery-address-selection, exactly one 40-lowercase-hex Feature SHA, this Matrix Source, Matrix Authority SHA-256, Matrix Approval Evidence, and a one-use Review Authorization ID formatted as review-auth: followed by a lowercase canonical UUIDv4. Objective, report, and registry must agree exactly. One authorization can be consumed by at most one review deployment. Any active review for this exact ticket/branch blocks another across Feature SHAs, authority revisions, and authorizations. Missing, duplicate, stale, malformed, or conflicting evidence blocks before project commands. HEAD must equal Feature SHA and a fresh raw-byte digest must match both header and approval comment.

Prerequisites:
- Trusted launcher has admitted the distinct ticket checkout and authenticated its repository/ticket/branch/Feature SHA evidence; run from that checkout root, never from the canonical analysis root.
- Nix with flakes enabled and access to the repository lock inputs; flake.nix supplies Flutter 3.44.0, Dart 3.12.0, Python 3.12, and Chromium. Python environment has the editable baker package, dev/web dependencies, pytest, and ruff installed. SQLite must be at least 3.35.0. app dependency resolution is available to the pinned SDK. No production credentials or production database is permitted.
- Shell is Bash; Git, Python, Nix, Flutter, and Dart are available. Review evidence and command logs are stored in the review deployment workspace outside tracked source. Capture each numbered command's stdout, stderr, exit status, duration, and candidate SHA there.
- Isolated running test backend and authenticated staff accounts for order-entry, cashier, and delivery UAT; seed a customer with a completed door order and a library suggestion, each with a distinct known map URL, plus a linkless library entry. No geocoding service is required.
- After command 9, execute all five companion UAT scenarios on the built candidate using desktop Chromium mouse and Android Chromium touch. Record browser/OS versions, reviewer, Feature SHA, all 24 AC1 combinations, AC1-AC5 results, regression checks, and edge cases in /isolated/ai-usage/agent-teams/requirements/artifacts/2026-10-11-FIX-237-uat-results.json before command 10. An unavailable platform or failed scenario blocks completion, not a skipped pass.

Environment:
- PA_FEATURE_SHA is the exact trusted-launch Feature SHA, matching ^[0-9a-f]{40}$ and HEAD; no guessed default is allowed.
- TERM=dumb and CI=true for deterministic noninteractive checks; each command supplies them explicitly.
- For UAT, configure the test app's existing backend setting to the isolated backend and use test-only accounts; record the actual endpoint in the UAT result. SDK and Chromium paths come only from nix develop .#flutter. No new application environment keys are introduced.

Commands (run in this exact order; each numbered item is one shell command):
1. `env TERM=dumb CI=true nix develop .#flutter --command bash -lc '[[ "$PA_FEATURE_SHA" =~ ^[0-9a-f]{40}$ ]] && test "$(git branch --show-current)" = "feature/FIX-237-delivery-address-selection" && test "$(git rev-parse HEAD)" = "$PA_FEATURE_SHA" && printf "%s\n" "$PA_FEATURE_SHA" && python -c "import sqlite3; assert sqlite3.sqlite_version_info >= (3,35,0); print(sqlite3.sqlite_version)" && flutter --version && dart --version'`
2. `env TERM=dumb CI=true nix develop .#flutter --command bash -lc 'cd app && flutter test test/features/orders/widgets/address_autocomplete_field_test.dart test/features/orders/widgets/stage3_delivery_options_screen_test.dart test/features/orders/widgets/order_edit_delivery_section_test.dart test/features/orders/order_edit_screen_save_test.dart test/features/orders/widgets/order_submission_mixin_test.dart test/features/orders/providers/order_form_draft_lifecycle_test.dart test/features/pos/pos_checkout_screen_test.dart test/providers/address_autocomplete_provider_test.dart test/providers/order/order_create_state_notifier_test.dart'`
3. `env TERM=dumb CI=true nix develop .#flutter --command python -m pytest tests/test_api_addresses.py tests/test_api_orders_address_library_sync.py -v`
4. `env TERM=dumb CI=true nix develop .#flutter --command python -m ruff check src tests --select E9,F63,F7,F82`
5. `env TERM=dumb CI=true nix develop .#flutter --command bash -lc 'cd app && flutter analyze'`
6. `env TERM=dumb CI=true nix develop .#flutter --command bash -lc 'cd app && dart analyze'`
7. `env TERM=dumb CI=true nix develop .#flutter --command python -m pytest tests -v`
8. `env TERM=dumb CI=true nix develop .#flutter --command bash -lc 'cd app && flutter test --coverage'`
9. `env TERM=dumb CI=true nix develop .#flutter --command bash -lc 'cd app && flutter build web --release'`
10. `env TERM=dumb CI=true nix develop .#flutter --command python -c 'import itertools,json,os,pathlib; p=pathlib.Path("/isolated/ai-usage/agent-teams/requirements/artifacts/2026-10-11-FIX-237-uat-results.json"); d=json.loads(p.read_text()); expected=set(itertools.product(("create","edit","pos"),("bus","door"),("pastOrders","library"),("mouse","touch"))); cases=d["selectionCases"]; assert d["ticket"]=="FIX-237" and d["featureSha"]==os.environ["PA_FEATURE_SHA"]; assert len(cases)==24 and {(c["flow"],c["deliveryType"],c["source"],c["pointer"]) for c in cases}==expected; assert all(c["status"]=="pass" and c["evidence"] for c in cases); assert set(d["acceptanceCriteria"])=={"AC1","AC2","AC3","AC4","AC5"} and all(v=="pass" for v in d["acceptanceCriteria"].values()); assert d["regressionChecks"]=="pass" and d["edgeCases"]=="pass"; assert d["reviewer"] and d["desktopBrowserVersion"] and d["androidBrowserVersion"] and d["desktopOsVersion"] and d["androidOsVersion"] and d["testBackend"] and d["evidenceRefs"]; print("FIX-237 UAT: 24/24 selection cases and AC1-AC5 passed")'`

Pass criteria:
- Commands Total: 10. Commands Passed must equal 10 (100% completion), with exit status 0 for every command at the same pinned Feature SHA. Do not change source, suppress failures, skip tests, or substitute commands to obtain a pass.
- Command 1 outputs candidate branch/SHA agreement, SQLite version at least 3.35.0, Flutter 3.44.0 and Dart 3.12.0. Commands 2-3 and 7-8 report every test passing; commands 4-6 report zero fatal lint/analyzer findings and exit 0; command 9 produces app/build/web/index.html; command 8 produces nonempty app/coverage/lcov.info. Command 10 validates the exact JSON report and prints the specified success line. Keep command logs and UAT screenshots/request-response evidence outside tracked source.
- Required review outputs: immutable candidate Feature SHA, source/digest/approval/authorization bindings, 10 command records, UAT JSON and evidence references, build output, coverage artifact, and findings report. Findings must satisfy Critical = 0 and Major = 0; every accepted/deferred Minor must have a named owner, rationale, and disposition. A failed command remains a failure even if its cause predates this ticket.
- Full matrix execution belongs only to the independently authorized review deployment; implementation phases run their named change-focused checks, not this full matrix. CI, UAT, merge, and ticket approval remain separate mandatory gates. Read-only review must not edit tracked source; tool caches/build outputs are verification artifacts only.

## After Matrix

Fixture only. No historical migration or approval.
