import assert from "node:assert/strict";
import { test } from "node:test";
import { selectsDocumentSession } from "../document-session.js";

test("fresh foreground requirements route is native-only and retained routes do not upgrade", () => {
  const fresh = { team: "requirements", mode: "analyze", pinned: false, resume: false, inherited: false, rogue: false, background: false, ticketWorktree: false };
  assert.equal(selectsDocumentSession(fresh), true);
  for (const field of ["pinned", "resume", "inherited", "rogue", "background", "ticketWorktree"] as const) assert.equal(selectsDocumentSession({ ...fresh, [field]: true }), false);
  for (const team of ["builder", "rogue-one", "repo-setup"]) assert.equal(selectsDocumentSession({ ...fresh, team }), false);
  for (const mode of ["auto", "spike", "review-auto"]) assert.equal(selectsDocumentSession({ ...fresh, mode }), false);
});
