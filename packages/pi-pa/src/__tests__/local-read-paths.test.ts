import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { localReadPathCandidates } from "../pi-extension/local-read-paths.js";

test("read candidates are finite, pure spelling transformations with relative/home/file-URL support", () => {
  const cwd = "/tmp/inert-candidate-root";
  assert.deepEqual(localReadPathCandidates("@note.txt", cwd), [join(cwd, "note.txt")]);
  assert.deepEqual(localReadPathCandidates("~/note.txt", cwd), [join(homedir(), "note.txt")]);
  assert.deepEqual(localReadPathCandidates(pathToFileURL(join(cwd, "space note.txt")).href, cwd), [join(cwd, "space note.txt")]);
  const paths = localReadPathCandidates("Café d'écran 10 PM.txt", cwd);
  assert.ok(paths.length <= 6);
  for (const name of ["Café d'écran 10 PM.txt", "Café d'écran 10\u202fPM.txt", "Café d'écran 10 PM.txt".normalize("NFD"), "Café d’écran 10 PM.txt", "Café d’écran 10 PM.txt".normalize("NFD")]) {
    assert.ok(paths.includes(join(cwd, name)), name);
  }
});

test("malformed local read requests reject with a fixed typed cause before delegation", () => {
  for (const input of [undefined, null, {}, "", "a\0b", "x".repeat(4097), "file://foreign-host/path", "file:///tmp/%GG"]) {
    assert.throws(() => localReadPathCandidates(input, "/tmp"), { code: "CONTENT_SOURCE_INVALID" });
  }
});
