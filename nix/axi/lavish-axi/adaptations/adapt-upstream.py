#!/usr/bin/env python3
"""PAP-197: selective Lavish 0.1.67 adaptation; never evaluate upstream CLI.
MIT upstream attribution/license is retained with the immutable closure.
Whole-file pins plus exact markers/replacement counts fail closed on any drift.
"""
import hashlib
import json
import pathlib
import sys

CLI_SHA = '973707874969efdf3e08ba544608aa4f32c755cf63ec586cad21d5ea8b076cdf'
CHROME_SHA = '3b862eafe265c2e3a0e87579ff9cae09cfdf3c675d668f1522c92da7ce65171a'
ARCHIVE_SHA = 'b04bd8eea71ece824ca5dc6837c98de04372b76ca6a28fe6e1a1ab025e50acfd'


def source(path, digest):
    data = pathlib.Path(path).read_bytes()
    assert hashlib.sha256(data).hexdigest() == digest, 'upstream source drift'
    return data.decode('utf-8')


def between(text, start, end):
    assert text.count(start) == 1 and text.count(end) == 1, 'extraction marker drift'
    return text.split(start, 1)[1].split(end, 1)[0]


def section(text, start, end):
    return start + between(text, start, end)


def patch(text, old, new):
    assert text.count(old) == 1, 'patch assertion drift'
    return text.replace(old, new)


def main():
    cli = source(sys.argv[1], CLI_SHA)
    chrome = source(sys.argv[2], CHROME_SHA)
    helpers = pathlib.Path(__file__).parent
    output = pathlib.Path(sys.argv[3])
    output.mkdir(parents=True, exist_ok=True)
    # Actual annotation extraction: no SDK initialization/globals, shadow DOM,
    # messages, attachments, diagram, layout audit or upstream network effects.
    native = section(cli, 'function isNativeInteractiveControl(el) {', 'function classifySevereTextOverflow(')
    selector = section(cli, '  function selector(el) {', '  function context(el, { table = false } = {}) {')
    selection = section(cli, '  function closestElement(node) {', '  function highlightElement(el) {')
    listeners = section(cli, '  document.addEventListener(\n    "mouseup",', '  setAnnotationMode(annotationMode);')
    binding = '''function bindLavishDocument(document, onTarget) {
  if (document !== frame.contentDocument || document.defaultView !== frame.contentWindow) throw new Error("frame binding");
  const annotationMode = true;
  let ignoreNextClick = false;
  const isNativeInteractive = isNativeInteractiveControl;
  function showAnnotationCard(element, options = {}) { onTarget(element, options.context || null); }
'''
    binding += native + selector + selection + listeners + '\n}\n'
    pieces = [binding]
    ranges = [
        ('function escapeHtml(value) {', 'function loadJsonState('),
        ('function persistQueuedPrompts() {', 'function promptTargetLabel('),
        ('function promptTargetLabel(prompt) {', 'function updateSendState() {'),
        ('function removeQueuedPrompt(index, event) {', 'function postToFrame('),
    ]
    for start, end in ranges:
        pieces.append(section(chrome, start, end))
    submit = section(chrome, 'async function submitQueuedOnce() {', 'function normalizeLayoutFindings(')
    submit = patch(submit, 'const body = { prompts: prompts.map(stripInternalPromptFields), domSnapshot: pendingSnapshot };', 'const body = prompts.map(toFeedbackEvent);')
    submit = patch(submit, '  if (shouldEndSession) body.endSession = true;\n', '')
    submit = patch(submit, 'fetch("/api/" + key + "/prompts", {', 'fetch("api/feedback", {')
    submit = patch(submit, '  for (const prompt of prompts) {', '''  const ack = await response.json();
  if (ack.status !== "acknowledged" || JSON.stringify(ack.eventIds) !== JSON.stringify(prompts.map(p => p.eventId))) {
    showQueuedSendFailure();
    throw new Error("invalid durable acknowledgement");
  }
  for (const prompt of prompts) {''')
    pieces.append(submit)
    # Trusted managed glue supplies only a small set of necessary UI hooks.
    glue = helpers.joinpath('outer.js').read_text()
    generated = '// Lavish 0.1.67, MIT; selective PA adaptation. See provenance.json.\n' + '\n'.join(pieces) + glue
    # No messaging, WS, arbitrary URL, SDK injection or forbidden effect survives.
    for forbidden in ['postMessage(', 'WebSocket(', 'XMLHttpRequest(', 'sendBeacon(', 'window.lavish', '/share', '/attachments', 'https://', 'http://']:
        assert forbidden not in generated, 'forbidden effect in generated adaptation'
    output.joinpath('review.js').write_text(generated)
    for name in ['outer.html', 'outer.css']:
        output.joinpath(name).write_bytes(helpers.joinpath(name).read_bytes())
    output.joinpath('provenance.json').write_text(json.dumps({
        'schema': 'pa-lavish-adaptation/v1', 'version': '0.1.67', 'archiveSha256': ARCHIVE_SHA,
        'sources': {'dist/cli.mjs': CLI_SHA, 'dist/chrome-client.js': CHROME_SHA},
        'reuse': ['SDK selector, text selection context and mouseup/click listeners',
                  'chrome escaped queue rendering/storage/removal/enqueue', 'chrome submit success-only queue consumption'],
        'patches': ['explicit contentDocument binding, no companion SDK execution',
                    'source-linked journal endpoint/body, exact durable ACK check'],
        'outputSha256': hashlib.sha256(generated.encode()).hexdigest(),
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
