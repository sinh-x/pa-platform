# Public reader source-aware content policy — PAP-289

Status: `.4` source candidate, not installed qualification or human UAT.
Runtime contract: [mode-capabilities.md](mode-capabilities.md).

## Owning decision and boundary

After inspecting the sensitive-content qualification failure, Sinh explicitly
selected **Allow public-web response content**, rather than redaction or continued
whole-page blocking. The decision disclosed that inbound public page text/title
will not be rejected solely for matching local secret-content regexes. Local-file
protection and outgoing URL/network checks remain unchanged. This is an intentional
policy change, not a claim that every public credential-shaped string is harmless,
a site allowlist, or a native package/approval receipt.

| Data source | Policy |
| --- | --- |
| Local files/paths/content | Existing shared built-in/local sensitive rules remain unchanged. |
| Supplied URL | Existing content/path/filename checks, credential-query restrictions and public HTTPS admission still apply before DNS. |
| Redirect URL | Same URL checks before another lookup/request; the prior request may have reached its server. |
| Inbound public response | Raw markup and extracted text/title are not rejected using local secret-content heuristics. Inert extraction, supported media, Unicode/byte/time/output limits and untrusted-evidence handling remain. |

The boundary is the trusted `readPublicWeb` response-processing path, not a model
claim. The native tool still accepts exactly `{url}`. A `source`/policy override,
`file:` URL or a local-file read labelled as web content does not grant an exemption.
The authenticated immutable capability binding, canonical-root reader, DNS/IP/TLS/
redirect guards, no credentials/cookies/proxy forwarding and lifecycle/resource
owners remain authoritative. Private/logged-in sources, arbitrary commands/modules
and other-role migration are not introduced.

No global matcher or local-file admission code changes. The reader still loads
sensitive patterns fail-closed for outbound URL validation. Response content is
public-source evidence, never instructions, approval or authority. Returning public
text also places it in the existing model transcript/retention domain.

## Result provenance and messages

The existing `pa-public-web-result/v1` success object gains these additive native
facts (caller/page data cannot set them):

```json
{
  "source": "public-web-response",
  "contentPolicy": "public-response-content-allowed/v1"
}
```

A `WEB_SENSITIVE` caused by URL validation additionally identifies `source` as
`supplied-url` or `redirect-url`. No raw URL, matched value, rule body or arbitrary
exception is added to failure guidance. Other failures omit this cause field.
Formatting admits only the two closed native URL labels; hostile context is not
stringified. Codes, exit/stream handling and other result members are retained.
This is an explicitly scoped additive machine/behavior change, not wording-only.

Affected human-facing paths:

- Success/clipping now says public response content is not secret-filtered and
  remains untrusted, with coverage/clipping limitations intact.
- Tool help distinguishes public response allowance from sensitive outbound URLs
  and unchanged local-file protection. It does not advertise general network/file
  authority or rendered completeness.
- Sensitive blockers retain one five-field envelope and the 2000-JavaScript-unit
  limit. Before: generic “input or output” rejection. After: a sensitive supplied or
  redirect URL was not requested, with native source context. `stage=requested`
  still warns that a previous request may have reached a server.

## Qualification finding and extraction limit

Original native denial: PAP-289 `c-20261111111526490`, `WEB_SENSITIVE`, requested,
cleanup settled. Subsequent separately authorized diagnostics (not native trial
passes), recorded in `c-20261111113414302` and `c-20261111113734614`, reproduced a
built-in key-assignment match in GitHub's JSON-embedded Python SDK example. No
candidate key value was exposed. The original historical body was not retained;
new response matches do not prove identical historical bytes.

The static extractor returned 1778 code points but none of `TypeSafeClient`,
`kev-latest` or `api_key`: it excluded the embedded documentation along with the
script. **The `.4` policy does not fix that extraction limitation.** Removing a
source-policy denial does not prove that the returned text includes the README,
hardware requirements or a complete rendered page. Meaningful extraction of
GitHub's embedded documentation (or an honest unsupported/incomplete result) is a
separate follow-up. Do not fetch another URL automatically or claim useful
read-and-answer/UAT success from a wrapper-only text result.

## Source checks and delivery

New `public-web-content-source.test.ts` covers all seven built-in content classes
and a local content rule: identical fixture data is blocked as a guarded local
file but allowed as inbound public response. Protected filenames, outbound
sensitive data, credential queries and redirect admission stay blocked. HTML/
title examples remain inert; source labels and extra properties cannot bypass
native tool/file/URL boundaries. Hostile source-formatting inputs cannot inject
prose or trigger conversion effects. Existing local sensitive-pattern and
public-reader/network/native-route regressions remain required.

Test-first new file: 0 passed/3 failed on `.3`. After implementation the old
whole-response-blocking fixture failed as expected under the deliberately changed
policy; it now asserts public-response allowance while retaining its outbound,
HTTP-error, unsupported-content and raw-exception non-disclosure negatives. This
change is not presented as retaining the former inbound-blocking invariant.

Actual final ordered checks, all with `NO_COLOR=1`:

- `corepack pnpm build` and `corepack pnpm typecheck`: passed.
- Core `corepack pnpm --filter @pa-platform/pa-core exec tsx --test --test-concurrency=1`
  with `src/__tests__/{public-web-content-source,public-web-reader,public-web-transport,mode-capabilities,sensitive-patterns,interactions-catalogue}.test.ts`:
  41 passed, zero failures/skips.
- Pi equivalent with
  `src/__tests__/{public-web-launch,mode-capability-session,document-session,document-native,document-workspace-dispatch,document-confirmation-native,document-confirmation-entry,interactions-discovery-native,interactions-ticket-native,pi-extension-composition,pi-native-host}.test.ts`:
  61 passed, zero failures/skips.
- Final test logs: `/tmp/pap289-source-policy-{core,pi}-final.log`. Original red
  output: `/tmp/pap289-source-policy-red.log`; first implementation run retaining
  the incompatible old response-blocking expectation:
  `/tmp/pap289-source-policy-first.log` (11 passed/1 failed).

Structural/plain-output/source-injection checks are not independent human
readability review. These fixtures do not qualify actual installed web behavior.

The worktree label is `0.1.160-pap289.4` across the four shared manifests;
`runtime-host` retains its independent version. Build from the exact clean commit
and verify actual source/version/provenance; do not patch installed metadata.
No installation, active config/pin edit, live `.4` request, native foreground
qualification, independent review, hosted CI or human readability/UAT is supplied
by source tests. Earlier aggregate/build timeouts and installed trial-only
provenance exceptions retain their original disposition.
