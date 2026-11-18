import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOCUMENT_PACKAGE_VERSION, DocumentPackageError, documentDestination, documentPackageSha, documentSource, parseDocumentPackage } from "../documents/package-contract.js";
import { readDocumentSources } from "../documents/package-tools.js";
import { inspectFullDocumentReader, presentFullDocumentReader } from "../documents/reader-publication.js";
import { digest } from "../workflows/contracts.js";
import { documentRuntimeFixture } from "./document-runtime-fixture.js";

const own = "d-abcdef", foreign = "d-123456";
const source = (name: string, deployment = own) => `deployments/${deployment}/artifacts/${name}`;

// Disposable native-owner fixture, not installed-profile or human qualification.
function fixture() {
  const f = documentRuntimeFixture();
  f.host.recoveryProfile = true; // Trusted qualified policy-profile document.package selection.
  f.host.workspaceProfile = true; f.host.confirmationProfile = true;
  const authenticate = f.host.authenticate;
  f.host.authenticate = () => ({ ...authenticate(), sessionId: "source-test-session" });
  for (const member of f.subject.members) {
    const next = source(`requirements/EX-1/r001/${member.id}.md`);
    mkdirSync(dirname(join(f.root, next)), { recursive: true });
    renameSync(join(f.root, member.source), join(f.root, next)); member.source = next;
  }
  const sha256 = () => documentPackageSha(f.subject);
  return { ...f, sha256 };
}
function assertFailure(result: Record<string, unknown>, code: string) {
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.code, code, JSON.stringify(result));
}
function resultField(response: Record<string, unknown>, field: string): unknown {
  const result = response.result;
  assert.ok(response.ok === true && result !== null && typeof result === "object" && !Array.isArray(result), JSON.stringify(response));
  return Reflect.get(result, field);
}
function assertNoIntake(f: ReturnType<typeof fixture>) {
  assert.equal(f.revision(), 0); assert.deepEqual(f.store.get("EX-1")!.doc_refs, []);
  for (const table of ["document_subjects", "document_snapshots"]) {
    assert.deepEqual(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), { n: 0 });
  }
}

test("PAP-316 deployment artifact grammar extends v1 without admitting arbitrary roots or deployment aliases", () => {
  assert.equal(DOCUMENT_PACKAGE_VERSION, "pa-document-package/v1");
  for (const path of [source("brief.md"), source("nested/review.txt", "d-000000"), "agent-teams/requirements/artifacts/drafts/d-abcdef/a.md", "agent-teams/requirements/artifacts/reviews/EX-1/r001/a.md"]) assert.equal(documentSource(path), path);
  for (const path of [
    "src/brief.md", "artifacts/brief.md", "/deployments/d-abcdef/artifacts/a.md", "prefix/deployments/d-abcdef/artifacts/a.md",
    "deployments-other/d-abcdef/artifacts/a.md", "deployments/d-abcdef/artifacts-extra/a.md", "deployments/d-abcdef/artifacts", "deployments/d-abcdef/artifacts/",
    source("a.md", "d-abcde"), source("a.md", "d-abcdef0"), source("a.md", "d-ABCDEF"), source("a.md", "d-ghijkl"), source("a.md", "d-abcdef-extra"),
    source("../private.md"), source("nested/../../private.md"), source("./a.md"), source("nested//a.md"), source("nested\\a.md"), source(".git/config"), source("a.md:stream"),
    "agent-teams/requirements/artifacts/packages/EX-1/a.md", "agent-teams/requirements/artifacts/reviews-extra/a.md",
  ]) assert.throws(() => documentSource(path), /DOCUMENT_INPUT|WORKFLOW_CONTRACT/, path);
});

test("PAP-316 qualified native draft/check/freeze binds exact own-deployment bytes without a historical-root copy", async () => {
  const f = fixture(); try {
    const originals = f.subject.members.map(m => readFileSync(join(f.root, m.source)));
    for (const [index, member] of f.subject.members.entries()) {
      rmSync(join(f.root, member.source));
      const authored = await f.call({ action: "draft", path: member.source, content: originals[index]!.toString(), expectedSha256: null });
      assert.equal(authored.ok, true, JSON.stringify(authored));
      assert.equal(resultField(authored, "path"), member.source);
    }
    const inodes = f.subject.members.map(m => statSync(join(f.root, m.source)).ino);
    const subject = parseDocumentPackage(f.subject), sha256 = f.sha256();
    assert.deepEqual(subject, f.subject);
    const checked = await f.call({ action: "check", package: subject });
    assert.equal(checked.ok, true, JSON.stringify(checked)); assert.equal(resultField(checked, "structuralPass"), true);
    const frozen = await f.call({ action: "freeze", package: subject, expectedRevision: 0 });
    assert.equal(frozen.ok, true, JSON.stringify(frozen)); assert.equal(resultField(frozen, "sha256"), sha256);
    assert.deepEqual(f.journal.subject(sha256), subject);
    for (const [index, member] of subject.members.entries()) {
      assert.deepEqual(f.journal.snapshot(member.sha256), originals[index]);
      assert.equal(existsSync(join(f.root, `agent-teams/requirements/artifacts/reviews/EX-1/r001/${member.id}.md`)), false);
      assert.equal(existsSync(join(f.root, documentDestination(subject, member))), false);
    }
    assert.deepEqual(subject.members.map(m => statSync(join(f.root, m.source)).ino), inodes);
    assert.deepEqual(f.store.get("EX-1")!.doc_refs, []); assert.equal(f.revision(), 1);
    assert.equal((await f.call({ action: "freeze", package: subject, expectedRevision: f.revision() })).ok, true);
    assert.equal(f.revision(), 1, "identical freeze is reused");
  } finally { f.close(); }
});

for (const profile of ["v1", "workspace-v2", "confirmation-v3", "interactions-v4"] as const) test(`PAP-316 retained ${profile} does not gain deployment-source authoring or intake`, async () => {
  const f = fixture(); try {
    f.host.recoveryProfile = false; f.host.workspaceProfile = profile !== "v1"; f.host.confirmationProfile = profile === "confirmation-v3" || profile === "interactions-v4";
    assertFailure(await f.call({ action: "draft", path: source("new.md"), content: "Unsigned draft", expectedSha256: null }), "DOCUMENT_UNAVAILABLE");
    for (const action of ["check", "freeze"]) assertFailure(await f.call({ action, package: f.subject, ...(action === "freeze" ? { expectedRevision: 0 } : {}) }), "DOCUMENT_UNAVAILABLE");
    assert.equal(existsSync(join(f.root, source("new.md"))), false); assertNoIntake(f);
    const path = `agent-teams/requirements/artifacts/drafts/${own}/retained.md`;
    assert.equal((await f.call({ action: "draft", path, content: "Historical draft still works", expectedSha256: null })).ok, true);
  } finally { f.close(); }
});

test("PAP-316 all deployment owners are checked before any member bytes, even with a foreign member last", async () => {
  const f = fixture(); try {
    // A read of the first member would fail STALE; ownership must reject first.
    writeFileSync(join(f.root, f.subject.members[0]!.source), "changed before intake");
    f.subject.members.at(-1)!.source = source("foreign.md", foreign);
    for (const action of ["check", "freeze"]) assertFailure(await f.call({ action, package: f.subject, ...(action === "freeze" ? { expectedRevision: 0 } : {}) }), "DOCUMENT_AUTHORITY");
    assertNoIntake(f);
  } finally { f.close(); }
});

test("PAP-316 foreign draft writes and historical-prefix tricks cannot create or replace files", async () => {
  const f = fixture(); try {
    const path = source("existing.md", foreign), absolute = join(f.root, path), original = "Foreign bytes stay unchanged";
    mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, original);
    for (const expectedSha256 of [null, digest(original)]) assertFailure(await f.call({ action: "draft", path, content: "Forbidden replacement", expectedSha256 }), "DOCUMENT_AUTHORITY");
    assert.equal(readFileSync(absolute, "utf8"), original);
    for (const path of [source("new.md", foreign), `agent-teams/requirements/artifacts/drafts/${foreign}/new.md`, `agent-teams/requirements/artifacts/drafts/${own}-extra/new.md`, source("../../outside.md"), "src/forbidden.md"]) {
      const result = await f.call({ action: "draft", path, content: "Forbidden write", expectedSha256: null });
      assert.equal(result.ok, false, path); assert.equal(existsSync(join(f.root, path)), false, path);
    }
    assertNoIntake(f);
  } finally { f.close(); }
});

test("PAP-316 own-deployment drafting keeps optimistic replacement and intake detects changed bytes", async () => {
  const f = fixture(); try {
    const member = f.subject.members[0]!, before = readFileSync(join(f.root, member.source)), content = "A revised concise brief.";
    const request = { action: "draft", path: member.source, content, expectedSha256: null };
    assertFailure(await f.call(request), "DOCUMENT_CONFLICT");
    assertFailure(await f.call({ ...request, expectedSha256: "0".repeat(64) }), "DOCUMENT_CONFLICT");
    assert.deepEqual(readFileSync(join(f.root, member.source)), before);
    const updated = await f.call({ ...request, expectedSha256: member.sha256 }); assert.equal(updated.ok, true, JSON.stringify(updated));
    for (const action of ["check", "freeze"]) assertFailure(await f.call({ action, package: f.subject, ...(action === "freeze" ? { expectedRevision: 0 } : {}) }), "DOCUMENT_STALE");
    assertNoIntake(f);
    member.bytes = Buffer.byteLength(content); member.sha256 = digest(content);
    assert.equal((await f.call({ action: "check", package: f.subject })).ok, true);
    assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, true);
    assertFailure(await f.call({ action: "draft", path: member.source, content: "Old digest cannot overwrite", expectedSha256: digest(before) }), "DOCUMENT_CONFLICT");
    assert.equal(readFileSync(join(f.root, member.source), "utf8"), content);
  } finally { f.close(); }
});

for (const variant of ["file-symlink", "ancestor-symlink", "hardlink", "directory", "sensitive-filename", "sensitive-path", "sensitive-content", "active-content", "invalid-utf8"] as const) test(`PAP-316 deployment intake preserves source protection: ${variant}`, async () => {
  const f = fixture(); try {
    const member = f.subject.members[0]!, original = join(f.root, member.source), bytes = readFileSync(original);
    if (variant === "file-symlink" || variant === "hardlink") {
      member.source = source("alias.md");
      if (variant === "file-symlink") symlinkSync(original, join(f.root, member.source)); else linkSync(original, join(f.root, member.source));
    } else if (variant === "ancestor-symlink") {
      symlinkSync(dirname(original), join(f.root, source("linked")), "dir"); member.source = source(`linked/${member.id}.md`);
    } else if (variant === "directory") { rmSync(original); mkdirSync(original); }
    else if (variant === "sensitive-filename" || variant === "sensitive-path") {
      member.source = source(variant === "sensitive-filename" ? ".env.md" : ".ssh/id_private.md");
      mkdirSync(dirname(join(f.root, member.source)), { recursive: true }); writeFileSync(join(f.root, member.source), bytes);
    } else {
      const raw = variant === "sensitive-content" ? Buffer.from("-----BEGIN PRIVATE KEY-----\nsynthetic noncredential fixture\n") : variant === "active-content" ? Buffer.from("<script>hostile()</script>") : Buffer.from([0xc3, 0x28]);
      writeFileSync(original, raw); member.bytes = raw.length; member.sha256 = digest(raw);
    }
    for (const action of ["check", "freeze"]) assertFailure(await f.call({ action, package: f.subject, ...(action === "freeze" ? { expectedRevision: 0 } : {}) }), "DOCUMENT_SOURCE");
    assertNoIntake(f);
  } finally { f.close(); }
});

for (const variant of ["file-symlink", "ancestor-symlink", "hardlink", "sensitive-filename", "sensitive-path", "sensitive-content", "active-content"] as const) test(`PAP-316 deployment drafting preserves safe file owner: ${variant}`, async () => {
  const f = fixture(); try {
    const original = join(f.root, f.subject.members[0]!.source), before = readFileSync(original);
    let path = source("new.md"), content = "Safe draft", expectedSha256: string | null = null;
    if (variant === "file-symlink" || variant === "hardlink") {
      if (variant === "file-symlink") symlinkSync(original, join(f.root, path)); else linkSync(original, join(f.root, path));
      expectedSha256 = digest(before);
    } else if (variant === "ancestor-symlink") {
      symlinkSync(dirname(original), join(f.root, source("linked")), "dir"); path = source("linked/new.md");
    } else if (variant === "sensitive-filename") path = source(".env.md");
    else if (variant === "sensitive-path") path = source(".ssh/id_private.md");
    else if (variant === "sensitive-content") content = "-----BEGIN PRIVATE KEY-----\nsynthetic noncredential fixture\n";
    else content = "<script>hostile()</script>";
    assert.equal((await f.call({ action: "draft", path, content, expectedSha256 })).ok, false, variant);
    assert.deepEqual(readFileSync(original), before);
    if (!["file-symlink", "hardlink"].includes(variant)) assert.equal(existsSync(join(f.root, path)), false);
    assertNoIntake(f);
  } finally { f.close(); }
});

test("PAP-316 historical drafts/reviews remain intake-compatible for retained native owners", async () => {
  const f = documentRuntimeFixture(); try {
    const member = f.subject.members[0]!, next = `agent-teams/requirements/artifacts/drafts/${own}/brief.md`;
    mkdirSync(dirname(join(f.root, next)), { recursive: true }); renameSync(join(f.root, member.source), join(f.root, next)); member.source = next;
    assert.equal((await f.call({ action: "check", package: f.subject })).ok, true);
    assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, true);
    assert.deepEqual(f.journal.subject(documentPackageSha(f.subject)), f.subject);
  } finally { f.close(); }
});

test("PAP-316 frozen deployment snapshots and delivery inspection are not re-intake by the current caller", async () => {
  const f = fixture(); try {
    assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, true);
    const sha256 = f.sha256(), snapshot = (hash: string) => f.journal.snapshot(hash);
    const delivery = await presentFullDocumentReader(f.subject, f.root, snapshot);
    const entry = fileURLToPath(String(delivery.entry)), before = readFileSync(entry), events = f.journal.events("example", "EX-1");
    for (const member of f.subject.members) rmSync(join(f.root, member.source));
    const authenticate = f.host.authenticate; f.host.authenticate = () => ({ ...authenticate(), deploymentId: foreign });
    f.host.recoveryProfile = false;
    for (const action of ["show", "present", "compare", "read"]) {
      const result = await f.call({ action, sha256, ...(action === "read" ? { path: "brief", offset: 0 } : action === "compare" ? { previousSha256: sha256 } : {}) });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    assert.equal((await inspectFullDocumentReader(f.subject, f.root, snapshot, String(delivery.deliverySha256))).entry, delivery.entry);
    assert.deepEqual(readFileSync(entry), before); assert.deepEqual(f.journal.events("example", "EX-1"), events);
  } finally { f.close(); }
});

test("PAP-316 existing owners can confirm/publish/queue and continue a frozen deployment lineage without intake ownership checks", async () => {
  const f = fixture(); try {
    assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, true);
    const sha256 = f.sha256(), authenticate = f.host.authenticate;
    f.host.authenticate = () => ({ ...authenticate(), deploymentId: foreign });
    const evidence = Buffer.from("synthetic-native-confirmation-not-human-qualification");
    f.host.confirm = async () => ({ outcome: "approved", principal: "source-test", interactionId: `interaction-${f.revision()}`, evidenceSha256: digest(evidence), nativeEvidence: evidence });
    const confirmed = await f.call({ action: "confirm", sha256, expectedRevision: f.revision(), scope: "publish-and-queue" });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed)); const decisionId = resultField(confirmed, "decisionId");
    for (const action of ["publish", "queue"]) {
      const result = await f.call({ action, sha256, decisionId, expectedRevision: f.revision() }); assert.equal(result.ok, true, JSON.stringify(result));
    }
    for (const member of f.subject.members) {
      const destination = documentDestination(f.subject, member);
      assert.match(destination, /^agent-teams\/requirements\/artifacts\/packages\//);
      assert.equal(digest(readFileSync(join(f.root, destination))), member.sha256);
      assert.ok(f.store.get("EX-1")!.doc_refs.some(ref => ref.path === destination));
    }
    const history = f.journal.events("example", "EX-1"), next = structuredClone(f.subject); next.revision++; next.predecessor = sha256;
    for (const member of next.members) {
      const old = member.source; member.source = member.source.replace(own, foreign).replace("r001", "r002");
      mkdirSync(dirname(join(f.root, member.source)), { recursive: true }); writeFileSync(join(f.root, member.source), readFileSync(join(f.root, old)));
    }
    const frozen = await f.call({ action: "freeze", package: next, expectedRevision: f.revision() }); assert.equal(frozen.ok, true, JSON.stringify(frozen));
    const nextSha = documentPackageSha(next);
    const approved = await f.call({ action: "confirm", sha256: nextSha, expectedRevision: f.revision(), scope: "publish" }); assert.equal(approved.ok, true, JSON.stringify(approved));
    const published = await f.call({ action: "publish", sha256: nextSha, decisionId: resultField(approved, "decisionId"), expectedRevision: f.revision() });
    assert.equal(published.ok, true, JSON.stringify(published)); assert.deepEqual(f.journal.events("example", "EX-1").slice(0, history.length), history);
    const refs = f.store.get("EX-1")!.doc_refs;
    assert.equal(refs.filter(ref => ref.path.startsWith("agent-teams/requirements/artifacts/packages/")).length, 10);
    assert.equal(refs.filter(ref => ref.path.startsWith("agent-teams/requirements/artifacts/approvals/")).length, 2);
    assert.equal(refs.length, 12); assert.equal(refs.filter(ref => ref.primary).length, 1);
    assert.equal(f.store.get("EX-1")!.doc_refs.find(ref => ref.primary)!.path, documentDestination(next, next.members.find(m => m.role === "requirements")!));
  } finally { f.close(); }
});

test("PAP-316 changed deployment bytes during confirmation or before publication cannot issue a decision or effect", async () => {
  const f = fixture(); try {
    assert.equal((await f.call({ action: "freeze", package: f.subject, expectedRevision: 0 })).ok, true);
    const sha256 = f.sha256(), member = f.subject.members[3]!, path = join(f.root, member.source), original = readFileSync(path), changed = Buffer.from(original);
    changed[0] = 33; // Same length, different digest.
    const evidence = Buffer.from("synthetic-confirmation-drift-test");
    f.host.confirm = async () => {
      writeFileSync(path, changed);
      return { outcome: "approved", principal: "source-test", interactionId: "drift-test", evidenceSha256: digest(evidence), nativeEvidence: evidence };
    };
    const request = { action: "confirm", sha256, expectedRevision: f.revision(), scope: "publish" };
    assertFailure(await f.call(request), "DOCUMENT_STALE"); assert.equal(f.revision(), 1);
    assert.deepEqual(f.store.get("EX-1")!.doc_refs, []); assert.deepEqual(f.journal.snapshot(member.sha256), original);
    writeFileSync(path, original);
    f.host.confirm = async () => ({ outcome: "approved", principal: "source-test", interactionId: "stable-test", evidenceSha256: digest(evidence), nativeEvidence: evidence });
    const approved = await f.call(request); assert.equal(approved.ok, true, JSON.stringify(approved));
    const events = f.journal.events("example", "EX-1"), refs = f.store.get("EX-1")!.doc_refs;
    writeFileSync(path, changed);
    assertFailure(await f.call({ action: "publish", sha256, decisionId: resultField(approved, "decisionId"), expectedRevision: f.revision() }), "DOCUMENT_STALE");
    assert.deepEqual(f.journal.events("example", "EX-1"), events); assert.deepEqual(f.store.get("EX-1")!.doc_refs, refs);
    for (const member of f.subject.members) assert.equal(existsSync(join(f.root, documentDestination(f.subject, member))), false);
  } finally { f.close(); }
});

test("PAP-316 deployment sources retain media, size, aggregate and metadata admission limits", () => {
  const f = fixture(); try {
    for (const [mediaType, bytes] of [
      ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ["image/jpeg", Buffer.from([255, 216, 255, 1, 255, 217])],
      ["text/plain", Buffer.from("Supporting plain text")],
    ] as const) {
      const member = f.subject.members[3]!;
      member.mediaType = mediaType; member.bytes = bytes.length; member.sha256 = digest(bytes); writeFileSync(join(f.root, member.source), bytes);
      assert.deepEqual(readDocumentSources(f.subject, f.root)[3], bytes);
    }
    for (const variant of ["image-limit", "text-limit", "role-media", "aggregate", "member-count", "metadata"] as const) {
      const subject = structuredClone(f.subject), member = subject.members[3]!;
      if (variant === "image-limit") { member.mediaType = "image/png"; member.bytes = 8_388_609; }
      else if (variant === "text-limit") member.bytes = 1_048_577;
      else if (variant === "role-media") subject.members[0]!.mediaType = "image/png";
      else if (variant === "aggregate") {
        for (const member of subject.members.slice(3)) { member.mediaType = "image/png"; member.bytes = 8_388_608; }
      } else {
        for (let i = 0; i < (variant === "member-count" ? 65 : 40); i++) subject.members.push({ ...member, id: `extra-${i}`, source: source(`extra-${i}.md`), description: "x".repeat(variant === "metadata" ? 2048 : 1) });
      }
      assert.throws(() => parseDocumentPackage(subject), DocumentPackageError, variant);
    }
  } finally { f.close(); }
});
