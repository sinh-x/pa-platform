
// PA-managed glue around the genuine pinned annotation/queue components above.
// Runs only in the packaged outer document; never in the scriptless companion.
const configuration = JSON.parse(document.body.dataset.config);
const frame = document.getElementById("artifact");
const annotationPills = document.getElementById("annotationPills");
const chatInput = document.getElementById("chatInput");
const sendButton = document.getElementById("send");
const queueButton = document.getElementById("queue");
const endButton = document.getElementById("end");
const notice = document.getElementById("notice");
const targetLabel = document.getElementById("target");
const queueStorageKey = "pa-lavish-v1:" + configuration.sessionId;
const internalQueueKeyField = "_lavishQueueKey";
let queued = [];
let ended = false;
let frozen = false;
let sending = false;
let endAfterSubmit = false;
let selectedTarget = { type: "document" };
let selectedText = "";
try {
  const saved = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
  if (Array.isArray(saved)) queued = saved.filter(sanitizeQueuedPrompt);
  chatInput.value = sessionStorage.getItem(queueStorageKey + ":draft") || "";
} catch { /* unavailable storage leaves the in-memory editor intact */ }
function sanitizeQueuedPrompt(value) {
  return value && typeof value === "object" && typeof value.eventId === "string"
    && typeof value.prompt === "string" && typeof value.selectedText === "string"
    && value.target && typeof value.target === "object" ? value : null;
}
function attachmentCount() { return 0; }
function pillAttachmentsHtml() { return ""; }
function updateSendState() {
  sendButton.disabled = ended || frozen || sending || !queued.length;
  queueButton.disabled = ended || frozen || sending;
  endButton.disabled = ended || sending;
}
function scrollPanelToBottom() { annotationPills.scrollTop = annotationPills.scrollHeight; }
function renderSheetSummary() {}
function clearSendAcknowledgementWarning() {}
function hideSendHint() {}
function armSendAcknowledgementWarning() {}
function setLayoutWarnings() {}
function showQueuedSendFailure() {
  notice.textContent = "Feedback was not acknowledged. Your text remains queued; retry or correct the rejected batch.";
}
function markSessionEnded() {
  ended = true;
  notice.textContent = "Review ended. Unsent text is retained locally. No automatic reopening.";
  updateSendState();
}
function toFeedbackEvent(prompt) {
  return { schema: "pa-artifact-feedback/v1", eventId: prompt.eventId,
    sessionId: configuration.sessionId, sourceRef: configuration.identity.sourceRef,
    sourceSha256: configuration.identity.sourceSha256, htmlSha256: configuration.identity.htmlSha256,
    target: prompt.target, selectedText: prompt.selectedText, feedbackText: prompt.prompt };
}
function noteTarget(element, selection) {
  if (ended || frozen || !element || element.ownerDocument !== frame.contentDocument) return;
  const section = element.closest("section[id]");
  const anchor = section && configuration.anchors.find(a => a.id === section.id);
  selectedTarget = anchor ? { type: "anchor", anchor: anchor.id, startLine: anchor.startLine, endLine: anchor.endLine } : { type: "document" };
  selectedText = selection ? selection.target.text : (element.textContent || "").trim();
  targetLabel.textContent = anchor ? "Source lines " + anchor.startLine + "–" + anchor.endLine : "Document-wide feedback";
  humanActivity();
  chatInput.focus();
}
function bindFrame() {
  // No SDK node, global, style or script is inserted into this document.
  const content = frame.contentDocument;
  if (!content || content.location.origin !== location.origin || content.location.pathname !== location.pathname + "content") return;
  bindLavishDocument(content, noteTarget);
  for (const event of ["pointerdown", "keydown", "wheel"]) content.addEventListener(event, humanActivity, { passive: true });
}
frame.addEventListener("load", bindFrame);
if (frame.contentDocument && frame.contentDocument.readyState === "complete") bindFrame();
let lastHumanActivity = 0;
function humanActivity() {
  if (ended || frozen || Date.now() - lastHumanActivity < 1000) return;
  lastHumanActivity = Date.now();
  fetch("api/activity", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
}
chatInput.addEventListener("input", () => {
  try { sessionStorage.setItem(queueStorageKey + ":draft", chatInput.value); } catch {}
  humanActivity();
});
queueButton.addEventListener("click", () => {
  if (ended || frozen || !chatInput.value.trim()) return;
  // Original enqueue stores before rendering. Failures retain text in editor.
  enqueuePrompt({ eventId: crypto.randomUUID(), prompt: chatInput.value, selectedText,
    target: selectedTarget, selector: selectedTarget.anchor || "document", tag: "annotation", text: selectedText });
  chatInput.value = "";
  try { sessionStorage.removeItem(queueStorageKey + ":draft"); } catch {}
  humanActivity();
});
sendButton.addEventListener("click", async () => {
  if (sending || ended || frozen || !queued.length) return;
  sending = true; updateSendState();
  try {
    if (await submitQueuedOnce() === false) {
      if (!ended) showQueuedSendFailure();
      return;
    }
    notice.textContent = "Durably acknowledged. Feedback is untrusted review data, not approval or instructions.";
  }
  catch { showQueuedSendFailure(); }
  finally { sending = false; updateSendState(); }
});
endButton.addEventListener("click", async () => {
  if (sending || ended) return;
  if (queued.length || chatInput.value.trim()) {
    notice.textContent = "Unsent text remains. Send or explicitly remove it before ending."; return;
  }
  try {
    const response = await fetch("api/end", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!response.ok || (await response.json()).status !== "ended") throw new Error("end not confirmed");
    markSessionEnded();
  } catch { notice.textContent = "Could not confirm the review ended."; }
});
const statusTimer = setInterval(async () => {
  if (ended) { clearInterval(statusTimer); return; }
  try {
    const response = await fetch("api/status");
    if (!response.ok) return;
    const state = await response.json();
    if (state.status === "stale") {
      frozen = true; notice.textContent = "Source or companion changed. Feedback is frozen; unsent text is retained."; updateSendState();
    } else if (state.status === "ended" || state.status === "stopped") markSessionEnded();
  } catch { /* A socket/poll never refreshes idle or silently restarts anything. */ }
}, 2000);
render();
