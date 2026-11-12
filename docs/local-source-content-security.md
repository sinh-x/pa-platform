# Local-source content security — PAP-292 follow-up

User correction after d-09f8df: every content-security decision needs trusted
source metadata plus content. For local sources, apply sensitive/security file
rules before allowing access; matching readable content is redacted before
presentation. This is not a public-web policy reversal or an approval grant.

## Contract

- Native implementations, not model JSON or text inside a document, determine
  source: local-file (actual path), local-tool-output (trusted tool), or the native
  public-web response. A caller cannot label a local file as remote to escape checks.
- Local source admission checks existing shared protected paths and configured
  filename/path rules on both logical and resolved paths. A blocked file stays
  blocked even if its text looks harmless. Redaction does not grant file access.
- Allowed local text is scanned with built-in and selected local content rules.
  Matching lines become `[REDACTED local sensitive content]`. Unmatched ordinary
  context stays readable. Private-key headers also suppress their body/footer or
  unterminated tail. Scan complete file text BEFORE read pagination; do not expose
  unscanned tails merely because a header was on an earlier page.
- Ordinary projections retain line count when possible. Text is not original
  bytes after redaction; do not treat its hash as the source digest or execute it
  as an approved input. Source/input/package/decision validators keep their
  existing rejection behavior and real bytes; do not redact an approval subject
  into a different silently accepted document.
- Matchers include configured patterns. Malformed/unavailable policy fails closed.
  Full local scans are bounded to 16MiB UTF-8. Excess matches/output are withheld,
  not a claim that an unscanned file is safe. These are explicit security limits.
- The native public reader's existing inbound public-text allowance remains;
  supplied/redirect URL checks still precede network work. A source label inside
  local content or tool input is never the native public reader's authority.
- No matched values, snippets, hashes of credentials or new raw-secret audit sink.
  Historical transcripts/audits are NOT rewritten. Prior exposure still needs
  credential-owner review; a new binary cannot retract old model context.

## Engineering slices

S1: pa-core source/content check, local source admission and redaction projections.
The existing assignment detector also recognizes a quoted JSON key; its prior
expression missed the closing quote before `:`. This narrows unsafe input acceptance
without replacing input-validator owners. Tests use inert canaries only.

S2: Pi integration must enforce this before local tool results/updates reach model,
TUI or runtime result capture. Preserve native capability guards and direct/nested
routes. Pure result transformation is separate from effect admission: a withheld
reply is never proof that an operation did not happen. Public results are exempt
only through their trusted native implementation, never a caller `source` field.

S3: reconcile source inventory, focused safety/composition/legacy tests, build and
typecheck. Record separate installed qualification, public-reader regression,
independent review and human UAT gaps. Commit each slice; do not install or mutate
active deployments/configuration to validate it.

This is managed-agent security, NOT a hostile same-UID filesystem sandbox or a
promise to identify every possible credential/encoding/image. In particular, shell
can generate/transform arbitrary bytes and native private evidence has its owning
policy; supported local projections must not be advertised as universal host data
loss prevention. Non-text attachments need their actual media-specific owner, not
an invented text/OCR pass.
