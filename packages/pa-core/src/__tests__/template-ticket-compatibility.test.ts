import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DOCUMENT_PROFILES } from "../templates/document-profiles.js";
import { digest, type TemplateId } from "../templates/schema.js";
import { templateService } from "../templates/service.js";
import { parsePairSignoff, parseTaskHandoff } from "../tickets/producer-contract.js";
import { isCanonicalTicketId } from "../tickets/validate.js";
import { templateFixture } from "./template-fixture.js";
import { producerFixture } from "./template-producer-fixture.js";

// Disposable identity/authority fixtures only. Never read or approve live PAPC-070 artifacts.
for (const ticket of ["FIX-70", "FIX-070", "PAPC-70", "PAPC-070", "A-0", "A-000"]) {
  test(`document render/validate preserves canonical ticket bytes ${ticket}`, () => {
    assert.equal(isCanonicalTicketId(ticket), true);
    const f = templateFixture(ticket);
    try {
      for (const id of Object.keys(DOCUMENT_PROFILES) as TemplateId[]) {
        const request = { action: "render", id, version: "1", bindings: { ticket } };
        const result = templateService(request, { selection: f.selection });
        assert.equal(result.ok, true, `${id}: ${JSON.stringify(result)}`);
        assert.ok((result.candidate as string).includes(ticket));
        assert.equal(templateService({ ...request, action: "validate", candidate: result.candidate }, { selection: f.selection }).ok, true);
        assert.equal((result.validation as { authority: boolean }).authority, false);
      }
    } finally { f.dispose(); }
  });
  for (const kind of ["fresh", "amendment"] as const) test(`${kind} handoff/pair/baseline preserves exact ${ticket}`, () => {
    const f = producerFixture(kind, ticket);
    try {
      const before = { ticket: readFileSync(f.ticketPath), source: readFileSync(f.requirementPath), refs: f.git(["show-ref"]), status: f.git(["status", "--porcelain=v2"]) };
      assert.equal(parseTaskHandoff(f.handoff.candidate as string).ticket, ticket);
      assert.equal(parsePairSignoff(f.pair.candidate as string).ticket, ticket);
      for (const [id, bindings, candidate] of [[`handoff-${kind}`, f.handoffBindings, f.handoff.candidate], ["pair-signoff", f.bindings, f.pair.candidate]] as const) {
        assert.equal(templateService({ action: "validate", id, version: "1", bindings, candidate }, { selection: f.selection }).ok, true);
      }
      const baseline = f.resolveBaseline();
      assert.equal(baseline.ticket, ticket);
      assert.equal(baseline.branch, `feature/${ticket}-templates`);
      assert.deepEqual({ ticket: readFileSync(f.ticketPath), source: readFileSync(f.requirementPath), refs: f.git(["show-ref"]), status: f.git(["status", "--porcelain=v2"]) }, before);
    } finally { f.dispose(); }
  });
}

const malformed = ["PAPC-", "papc-070", "PAPC--070", "PAPC-+070", "PAPC-07a", "PAPC-０７０", " PAPC-070", "PAPC-070 ", "PAPC-070\n", "PAPC-070\u200b", `PAPC-${"0".repeat(60)}`];
test("document metadata and typed bindings reject malformed or oversized ticket IDs", () => {
  const f = templateFixture();
  try {
    const entry = f.registry.entries.find(e => e.id === "uat-plan")!, path = join(f.root, entry.source.path), original = readFileSync(path, "utf8");
    for (const ticket of malformed) {
      assert.equal(isCanonicalTicketId(ticket), false);
      assert.equal(templateService({ action: "render", id: "uat-plan", version: "1", bindings: { ticket } }, { selection: f.selection }).ok, false, ticket);
      // A newline ends a Markdown field, so it is tested as a scalar binding
      // above, not as an invalid value embedded in a multi-line document.
      if (!ticket.includes("\n")) {
        const body = original.replace("> Ticket: {{ticket}}", `> Ticket: ${ticket}`);
        writeFileSync(path, body); entry.source.sha256 = digest(body);
        assert.equal(templateService({ action: "render", id: "uat-plan", version: "1", bindings: { ticket: "FIX-1" } }, { selection: f.save() }).ok, false, ticket);
      }
      writeFileSync(path, original); entry.source.sha256 = digest(original); f.selection = f.save();
    }
  } finally { f.dispose(); }
});

for (const kind of ["fresh", "amendment"] as const) {
  test(`${kind} handoff/pair parsers reject malformed IDs and padded/unpadded aliases`, () => {
    const f = producerFixture(kind, "PAPC-070");
    try {
      for (const ticket of [...malformed.filter(id => !id.includes("\n")), "PAPC-70"]) {
        assert.throws(() => parseTaskHandoff((f.handoff.candidate as string).replace("Ticket: PAPC-070", `Ticket: ${ticket}`)));
        assert.throws(() => parsePairSignoff((f.pair.candidate as string).replace("Ticket: PAPC-070", `Ticket: ${ticket}`)));
      }
      for (const branch of ["feature/PAPC-70-templates", "feature/PAPC-070-../escape", "feature/PAPC-070-a//b", "feature/PAPC-070-a.lock", "feature/PAPC-070-a/"]) {
        assert.throws(() => parseTaskHandoff((f.handoff.candidate as string).replace(f.bindings.branch, branch)));
        assert.throws(() => parsePairSignoff((f.pair.candidate as string).replace(f.bindings.branch, branch)));
      }
      if (kind === "amendment") {
        for (const tupleApprovalEvidence of ["PAPC-70#c-19990101000000000", "PAPC-070#c-short", "PAPC-070#c-19990101000000000\n"]) {
          assert.equal(templateService({ ...f.request, bindings: { ...f.bindings, tupleApprovalEvidence } }, { selection: f.selection }).ok, false);
        }
      }
    } finally { f.dispose(); }
  });
  for (const variant of ["ticket", "branch", "preview-path", "published-ticket", "forged-author", "draft", "withdrawn", "missing-primary"] as const) {
    test(`${kind} padded baseline rejects ${variant} without Git or evidence changes`, () => {
      const f = producerFixture(kind, "PAPC-070");
      try {
        const comment = f.record.comments[0]!;
        if (variant === "ticket") comment.content = comment.content.replace("Ticket: PAPC-070", "Ticket: PAPC-70");
        if (variant === "branch") comment.content = comment.content.replace("feature/PAPC-070-templates", "feature/PAPC-70-templates");
        if (variant === "preview-path") comment.content = comment.content.replace("reviews/PAPC-070/", "reviews/PAPC-70/");
        if (variant === "published-ticket") writeFileSync(f.requirementPath, readFileSync(f.requirementPath, "utf8").replace("Ticket: PAPC-070", "Ticket: PAPC-70"));
        if (variant === "forged-author") comment.author = "requirements/analyst";
        if (variant === "draft") writeFileSync(f.requirementPath, readFileSync(f.requirementPath, "utf8").replace("Status: Approved — synthetic fixture only", "Status: Draft"));
        if (variant === "withdrawn") f.record.comments.push({ id: "c-20000102000000000", author: "sinh", content: "I withdraw this approval.", timestamp: "2000-01-02T00:00:00.000Z" });
        if (variant === "missing-primary") f.record.doc_refs = [];
        f.saveTicket();
        const before = { ticket: readFileSync(f.ticketPath), source: readFileSync(f.requirementPath), refs: f.git(["show-ref"]), status: f.git(["status", "--porcelain=v2"]) };
        let gitCalls = 0;
        assert.throws(() => f.resolveBaseline(() => { gitCalls++; throw new Error("must reject before Git"); }), /ORDINARY_BASELINE_/);
        assert.equal(gitCalls, 0);
        assert.deepEqual({ ticket: readFileSync(f.ticketPath), source: readFileSync(f.requirementPath), refs: f.git(["show-ref"]), status: f.git(["status", "--porcelain=v2"]) }, before);
      } finally { f.dispose(); }
    });
  }
}

test("requirements matrix identity mismatch remains invalid even with a correct raw digest", () => {
  const f = templateFixture("PAPC-070");
  try {
    // The matrix/digest is for PAPC-070; substituting the numerically equivalent
    // ticket and branch in the rendered headers is not canonical identity equality.
    const result = templateService({ action: "render", id: "requirements", version: "1", bindings: { ticket: "PAPC-70" } }, { selection: f.selection });
    assert.equal(result.ok, false);
  } finally { f.dispose(); }
});
