# PAP-327 runtime implementation and qualification

This document records source-level phase exits. It is not installed qualification, workflow adoption, or human acceptance. PAPC owns workflow policy and any future sign-only selection. Existing combined scopes and historical native records remain authoritative for their original operations.

## P0: Baseline controls

Baseline source: `8420ccc615745c6cee8b1173e817b9a037bc38ba`.

Before rebuilding, the compiled worker was SHA-256 `a719ed5a3482a952ef321e15475fb55919fd299d2eaafc89473087d5e86a9cfb`, renderer `bdd9e514bd5681d5df3aa5b51ab1c38b20a12ab35ce96d876720e2179000d55d`, and package contract `d7074ddc5bcdb50fa49b38d9a3c867233892ce35e649bfb6d31194cd9b2f42fb`. The compiled package contract includes deployment-source grammar.

The exact named PAP-316 frozen deployment snapshot/delivery fixture passed (1/1). The deployment-source, handoff-intake and reader-worker controls passed (51/51). Thus this pairing does not reproduce the historical DOCUMENT_INPUT; no speculative parser/rendering fix was applied. The historical 42/43 result is not erased or diagnosed solely from this control.

The combined handoff/local review suites completed 74/74 in 137.7 seconds under a 180-second bound. An initial 55-second bound expired after 25 completed cases, without an observed failing case. A 90-second wrapper is insufficient for this measured source run. This does not prove the historical timeout's sole cause, installed parity, or actual two-client interaction.

Full commands, exits and source/compiled hashes are preserved in deployment `d-5ee695`, `artifacts/checks/pap-327-p0/baseline.json`.

## Historical boundary

The d-f04824 DOCUMENT_CONFLICT happened during intake, before a review subject/reference existed. Its cause remains unproven. The original native intake owner must inspect the original association, intent and custody; no live replay, replacement request/package, refreshed CAS or status workaround was performed. PAP-300 remains responsible for applicable historical custody recovery, not a blanket prerequisite or bypass.
