# Planned reader

PAP-327 P4 supplies a complete, trusted-inert Planned delivery. It does not issue approval, publish ticket references, open a browser, attach Actual reports, or adopt a workflow.

## Entry and fallbacks

New deliveries use `pa-document-reader/v2`. `index.html` contains every required member once, in manifest order, inside independent native `<details>` disclosures. The member with role `brief` starts open even when it is not first; every other member starts closed. There is no exclusive accordion group, scripted state, or active approval control.

The contents navigation, previous/next links, standalone member pages, exact raw sources, and `manifest.json` remain local and complete. Member and heading fragment targets are **inside** disclosure content, so native ancestor reveal can open the closed member. The brief is no longer duplicated above the ordered view. Full standalone member pages remain uncollapsed.

Summaries have native keyboard semantics and visible focus. Heading IDs are generated, not user slugs. Skip links, labelled keyboard-focusable table/code overflow regions, wrapping metadata, and described images are retained. Unsupported links/markup stay literal; no script, remote resource, or arbitrary module is admitted. The CSP binds the exact stylesheet hash.

## Fragment and print boundary

The v2 print stylesheet exposes closed `details::details-content` with both `display:block` and `content-visibility:visible`, as well as a child display rule. A display rule alone is not sufficient for Chromium's native closed-content hiding. Print wraps long code and tables instead of clipping their local scroll regions. No before-print script or manual opening is required.

An isolated **headless Chrome 156.0.8078.79** run exercised the actual compiled-worker-generated multi-member reader, not just inspected HTML:

- Initial state was brief open and five other members closed.
- A closed inner-heading fragment and a canonical member fragment opened their ancestor.
- Keyboard Space opened another member without closing the brief; the focused summary had a visible solid outline.
- At 375 CSS px, all members open, document scroll width was 360px. Long code remained inside labelled local overflow regions.
- An actual generated PDF, with **all** disclosures closed before printing, contained every text member's final sentinel and the image description. Extracted code/table content retained all 750 repeated tokens of each kind; table extraction removes repeated print headers that interrupt words at page boundaries.

These are automated Chromium observations, not human keyboard acceptance, actual screen-reader observation, real 200% browser zoom, visual print inspection, or proof for another browser engine. Those TS-05/NFR-04 evidence classes remain **Not run**. Unsupported engines must be qualified before being claimed; full standalone pages do not substitute for the required entry behavior.

The disposable candidate, browser harness, PDFs, and results are preserved under deployment `d-5ee695`, `artifacts/checks/pap-327-p4/`. PDF extraction initially failed on the harness's one-byte font decoding and on repeated print headers; neither required a renderer change. No installed profile or live historical intake was exercised.

## Immutable identity and historical inspection

The delivery identity still binds subject, revision, effects, ordered members and renderer identity. The current renderer hashes its actual implementation dependencies. New v2 output never replaces a v1 folder, manifest, completion record, or approved reference.

`inspectFullDocumentReader` reads only the exact subject/delivery's bounded immutable manifest to select the current v2 recipe or the **retained local v1 recipe**. It does not require a v2 derivation before inspecting v1, so historical inspection keeps its own finite output budget. The v1 renderer's original implementation digest is retained as an identity input, not trusted as authority or used to load code. The fixed bounded worker re-derives all source, member HTML, entry HTML and manifest bytes with that recipe. The owner then verifies every output and the exact completion record before returning the historical entry. Unknown versions, malformed renderer identity, changed/missing outputs and missing completion records fail closed. Inspection neither repairs nor upgrades anything.

`document-reader-v1-fixture.json` was captured from the P0 compiled worker before P4 source/build changes. Tests pin its complete manifest, delivery identity, manifest digest, output lengths and hashes. Historical reproduction is established for this retained v1 recipe, not for arbitrary unarchived implementations that happened to share a version label; an incompatible historical recipe must remain an explicit failure, never an unsafe stored-HTML fallback.

## P5 and other consumer seams

Use the existing `presentFullDocumentReader` result only after complete native verification; it returns the entry/manifest locators, `deliverySha256`, `manifestSha256`, subject digest, revision, ordered member identities/raw/companion paths, effects and renderer identity. `inspectFullDocumentReader` consumes the **exact** subject and delivery digest, including retained v1. No export hub or ticket-reference owner changes are included in P4.

P5 must obtain repository/ticket/reviewed-plan identity and candidate binding from their existing authorized owners, join them to this exact subject/member-or-manifest identity, and attach/project through the ticket/report owner. Do not select the newest folder, infer matching Actuals from HTML text, or rewrite Planned bytes. Preserve explicit unmatched/denied/missing states and independent evidence classes, including human UAT Not run/Pending. Reader verification grants no signing, publication, attachment, or launch authority.
