# PAP-302 — remaining runtime phases (activation withheld)

The operator explicitly requested P2–P5 implementation after creating companion
**PAPC-086**, and reserved final activation/integration for manual handling. This
supersedes the earlier planning-only stop, not the retained safety/approval owners.
All edits remain in the PAP-302 ticket worktree. No PAPC configuration, user service,
provider session, live ticket worker, checkout, remote operation or activation is
performed by this development session.

## P2 — global coordination, bounded drafting and foreground support

- Registry schema 18 adds a global unique active slot, append-only hash-linked
  item history, controls and immutable first-owner claims. This is coordination,
  **not a permission/approval ledger**. Every awaiting, blocked, uncertain and
  review-ready item holds the same slot across PAP/PAPC and OS processes.
- Initial scanning/dispatch controls are disabled/paused. CAS reauthenticates under
  the existing registry transaction. Pause preserves a worker and all original
  state; a close needs settled original-owner proof. Missing PID/reply is never
  permission to execute again. Pure list/status retain existing-files-only reads.
- Bare `ppa auto` in a genuine unmanaged terminal offers human selection with
  complete 100-row pages and default Cancel. Managed/headless/JSON calls have no
  selection/approval flags. Existing pending packages are retained, not redrafted.
- A new explicit committed `contracts/auto-waitlist-v1.json` compatibility contract
  is required for effects. Retained analyze/analyze-auto modes are untouched.
  Selected source resources/provider/model are pinned and rechecked; absent or
  mismatched pairing blocks only the dependent effect. PAPC-086 owns actual config.
- The producer is a new native finite protocol, **not** a headless document approval
  profile. Tool-less noninteractive Pi requests bounded read/list observations from
  native source-aware readers, then emits full unsigned brief/requirements/UAT and
  material questions. It cannot invoke source/ticket/Git/checkout/launch tools.
  Native code owns outside-repository draft writes, structural checks and immutable
  document snapshots; original request/deployment IDs precede effects.
- CLI flags needed for no-tools/no-extensions/no-MCP/no-context/no-session isolation
  are probed, not guessed on older Pi. No fallback weakens those restrictions.
  Investigation bounds: 32 source requests, 128 KiB/file, 1 MiB total source,
  1 MiB response, 30-minute wall deadline. No live provider was invoked in tests.
- Native foreground review support exposes every complete text member and exact
  technical start bindings before one final decision (Cancel by default). A
  trusted terminal fixture tests UI behavior; synthetic choices are not genuine
  human approval evidence. P3 owns durable finite-start issuance and dispatch.

Message changes: passive list now says “this list does not select, approve or
execute work” instead of the obsolete global “selection ... not enabled”. Status
exposes observed active IDs/states or explicitly unobserved ownership. Native
blockers retain one static bounded five-field envelope and no raw exceptions.
Catalogue semantic reconciliation distinguishes scan (coordination **write**) from
interactive opening (possible native **launch**). Null native bindings remain null.

Initial focused P2 run: 21 pass / 1 fail, caused by a test expecting an ordinary
object from the strict null-prototype JSON parser. The draft reply boundary now
reconstructs its closed canonical data shape; the repeated new core/native tests
passed 13/13. Final P2 combined run passed **47/47** (auto coordination,
waitlist, catalogue and Pi native/compiled-CLI cases), zero skips/cancellations.
Core build and Pi TypeScript build passed. Evidence: `/tmp/pap302-p2-tests.log`.
Source checks do not establish actual desktop delivery, provider output usefulness,
installed pairing, independent review, hosted CI or human UAT.
