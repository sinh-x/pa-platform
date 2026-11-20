# Exact content-only document review

PAP-327 P1 adds a branch-independent signing route. It does **not** publish,
change Git refs or ticket links, queue work, change ticket status or assignee,
allocate resources, invoke a runner, or launch implementation.

## Find and sign

The native document owner first freezes the complete package using the existing
document intake. With `document.package`, `document.handoff` and
`document.local-review` immutably selected, it calls `pa_document` with
`review-prepare(sha256)`. Preparation verifies the full immutable reader delivery
and returns one copyable `review:…` reference. No branch plan or effect mask is
accepted. Calling prepare again for the same document and delivery reuses the
original reference, even from another eligible native session.

From the ticket, discover references without selecting a revision:

```text
ppa document review list EX-1
```

Copy one reference into either client:

```text
ppa document review REFERENCE
/pa-review REFERENCE
```

`REFERENCE` means the complete issued `review:…` value, not a ticket, file or URL.
PPA guides the terminal reviewer through the full content and delivery locations;
no JSON, hashes, revisions or request keys need to be assembled. Pi displays all
required members in tabs, with reader/raw/manifest locations in Delivery. Tab and
PageUp/PageDown navigate; Up/Down changes the visibly marked choice; Enter submits.
Cancel is the default. Image bytes are verified, but automatic image viewing is
not claimed. The generated reader is inert and contains no signing controls.

`/pa-review EX-1` only lists references. An empty command gives guidance; a bare
ticket never signs or guesses “latest.” `ppa document review show REFERENCE` is
read-only and includes saved history even if the original delivery later becomes
unverified. Missing or changed delivery disables new decisions, not saved history.
Discovery returns only references whose native origin and complete delivery verify.
An empty result does not prove why an original intake stopped; ask its owner to
inspect existing evidence, rather than replacing or replaying the intake.

The new `pa_document` actions are `review-prepare(sha256)`, `review-list(ticket)`,
`review-show(reference)` and `review-sign(reference)`. `pa_handoff` also accepts
`pa-content-review/v1` with `prepare(sha256)`, `list(ticket)`, `show(reference)`,
`review(reference)`, `request(reference)` and `decide(reference,outcome)`. The last
two use the same deliberately unauthenticated local confirmation owner as PPA;
agent-provided outcomes are not human-identity evidence. Unknown fields, imported
identities, arbitrary roots and caller-supplied request coordinates are rejected.

## One shared outcome

All clients use the existing native handoff subjects, events and captures tables;
there is no second approval ledger. The new subject has purpose
`sign-content-only` and a null branch intent. Native origin, exact document
identity, ordered members and delivery are immutable. No effect flags are granted.

- Closing, disconnecting or Ctrl-C in guided PPA detaches; pending remains pending.
- Deliberately choosing Cancel, including the displayed default, records cancellation.
- Pi reconciles a PPA decision and closes its pending view without submitting Cancel.
- An identical decision replay returns the original decision. An opposing outcome
  cannot overwrite it. A saved decision never opens another unchanged prompt.
- Request/decision reply loss is recovered through the same reference, not a new
  request or approval. Issuance and its local evidence are one durable transaction.

Approval acknowledges **Approved · Not published**. All outcomes are
`local-unverified`; authentication is `not-provided`. The reference is a bounded
pointer, not a bearer credential. Like the existing local review route, this is
not isolation against another process with the same local data access. Local
CLI availability does not grant another runtime session a missing capability.

Legacy PPA `--request-stdin`, loopback HTTP, Pi confirmation JSON and combined
handoff/effect routes retain their existing contracts. New content references
cannot be consumed by those effect routes. No new HTTP endpoint is added.

## P2 boundary: separately authorized Publish

P1 stops after the exact content decision. P2 must read the original
`RegistryHandoffReviewJournal.contentSubject()` binding and its canonical
requested/issued events, retaining the same decision ID, document identity and
delivery identity. It must **not** call the combined-scope `approved()` method or
convert this subject into publication/ref/queue authority.

A separately authorized publisher must independently establish finite publication
authority, active content eligibility and current caller/custody/lifecycle/target/
predecessor/source/delivery admission. Its existing operation owner must persist
intent before writes, verify all files and exact structured refs before primary,
and resume only the original operation after interruption. That work is not
implemented here and must not require another unchanged content signature.

Source tests are not installed qualification, browser/screen-reader observations,
independent review or human UAT. None of those claims follows from this document.
