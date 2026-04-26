import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanSignalEntries, getSignalPaths, isSensitive, markSignalNoteAsProcessed, parseSignalNoteMarkdown, parseSqlcipherRows, readCollectorState, routeRawSignalNote, saveRawNote, writeCollectorState, writeRoutedMessage } from "../index.js";
import type { NoteToSelfMessage } from "../index.js";

test("signal router classifies tags, URLs, sensitive text, and attachments", () => {
  assert.deepEqual(routeRawSignalNote("---\nattachmentsCopied: [\"/tmp/a.png\"]\n---\n\n#idea Build a thing"), {
    destination: "ticket-idea",
    content: "Build a thing",
    tag: "idea",
    detectedUrl: null,
    sensitiveDetected: false,
    attachmentOnly: false,
    attachmentPaths: ["/tmp/a.png"],
  });
  assert.equal(routeRawSignalNote("---\n---\n\nhttps://youtu.be/demo").destination, "youtube-queue");
  assert.equal(routeRawSignalNote("---\n---\n\nhttps://github.com/sinh/foo").destination, "spike-queue");
  assert.equal(routeRawSignalNote("---\n---\n\nsgnl://linkdevice?uuid=abc").destination, "sensitive");
  assert.equal(routeRawSignalNote("---\nattachmentsCopied: [\"/tmp/file.pdf\"]\n---\n").destination, "attachment-only");
  assert.equal(isSensitive("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test"), true);
});

test("signal reader helpers manage state and raw notes under a configurable base dir", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-signal-"));
  try {
    const paths = getSignalPaths(root);
    assert.deepEqual(readCollectorState(paths.stateFilePath), { lastProcessedAt: 0, lastRunAt: null, totalProcessed: 0 });
    writeCollectorState({ lastProcessedAt: 123, lastRunAt: "2026-04-26T00:00:00.000Z", totalProcessed: 2 }, paths.stateFilePath);
    assert.equal(readCollectorState(paths.stateFilePath).lastProcessedAt, 123);

    const note: NoteToSelfMessage = {
      id: "m-1",
      conversationId: "c-1",
      sentAt: Date.UTC(2026, 3, 26, 1, 2),
      body: "#task Test signal",
      attachments: [{ messageId: "m-1", contentType: "image/png", path: "aa/bb", fileName: "image.png", size: 10, width: 1, height: 1, duration: null, attachmentType: "attachment" }],
    };
    const rawPath = saveRawNote(note, ["/copied/image.png"], paths.rawDir);
    const parsed = parseSignalNoteMarkdown(readFileSync(rawPath, "utf-8"));
    assert.equal(parsed.frontmatter["id"], "m-1");
    assert.equal(parsed.body, "#task Test signal");
    const processedPath = markSignalNoteAsProcessed(rawPath, paths.processedDir);
    assert.equal(existsSync(processedPath), true);
    assert.deepEqual(parseSqlcipherRows("ok\nfoo|bar\n\n"), [["foo", "bar"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("signal writers use configurable destinations and ticket store", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-core-signal-writers-"));
  try {
    const paths = {
      learningRepo: join(root, "learning"),
      signalBase: join(root, "signal"),
      youtubeQueue: join(root, "queue", "youtube-video-queue.txt"),
      ticketsDir: join(root, "tickets"),
    };
    mkdirSync(join(root, "queue"), { recursive: true });
    writeFileSync(paths.youtubeQueue, "", { flag: "a" });
    const youtube = routeRawSignalNote("---\n---\n\nhttps://youtube.com/watch?v=abc");
    const writeResult = writeRoutedMessage(youtube, Date.UTC(2026, 3, 26, 3, 4), { paths });
    assert.equal(writeResult.destination, "youtube-page");
    assert.ok(writeResult.ticketId?.startsWith("LM-"));
    assert.match(readFileSync(paths.youtubeQueue, "utf-8"), /youtube\.com\/watch\?v=abc/);

    const idea = routeRawSignalNote("---\n---\n\n#idea Build from Signal");
    const ticketResult = writeRoutedMessage(idea, Date.UTC(2026, 3, 26, 3, 5), { paths });
    assert.ok(ticketResult.ticketId?.startsWith("PA-"));

    const journalPath = join(paths.learningRepo, "journals", "2026_04_26.md");
    assert.match(readFileSync(journalPath, "utf-8"), /#signal #youtube/);
    assert.equal(cleanSignalEntries({ paths }), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
