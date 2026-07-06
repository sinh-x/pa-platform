import test from "node:test";
import assert from "node:assert/strict";
import { buildBranchName, validateBranchName } from "../tickets/git-validation.js";

const PATTERN = "feature/<ticket>-<topic>";

test("buildBranchName: single ticket produces feature/<ticket>-<topic>", () => {
  assert.equal(buildBranchName(["PAP-001"], "fix-login", PATTERN), "feature/PAP-001-fix-login");
});

test("buildBranchName: multiple tickets are hyphen-joined", () => {
  assert.equal(
    buildBranchName(["PAP-001", "PAP-002"], "shared-work", PATTERN),
    "feature/PAP-001-PAP-002-shared-work",
  );
});

test("buildBranchName: topic with spaces is converted to hyphens", () => {
  assert.equal(buildBranchName(["PAP-001"], "fix login bug", PATTERN), "feature/PAP-001-fix-login-bug");
});

test("buildBranchName: topic with uppercase is lowercased", () => {
  assert.equal(buildBranchName(["PAP-001"], "FixLogin", PATTERN), "feature/PAP-001-fixlogin");
});

test("buildBranchName: topic special characters are removed", () => {
  assert.equal(buildBranchName(["PAP-001"], "fix@login!bug", PATTERN), "feature/PAP-001-fixloginbug");
});

test("buildBranchName: consecutive hyphens in topic are collapsed", () => {
  assert.equal(buildBranchName(["PAP-001"], "fix--login", PATTERN), "feature/PAP-001-fix-login");
});

test("buildBranchName: leading and trailing hyphens in topic are stripped", () => {
  assert.equal(buildBranchName(["PAP-001"], "--fix-login--", PATTERN), "feature/PAP-001-fix-login");
});

test("buildBranchName: custom pattern substitutes both placeholders", () => {
  assert.equal(
    buildBranchName(["AVO-028"], "api-endpoints", "feature/<ticket>/<topic>"),
    "feature/AVO-028/api-endpoints",
  );
});

test("buildBranchName: throws when no tickets provided", () => {
  assert.throws(() => buildBranchName([], "topic", PATTERN), /at least one ticket id/);
});

test("buildBranchName: throws when topic is empty after sanitization", () => {
  assert.throws(() => buildBranchName(["PAP-001"], "@@@@", PATTERN), /empty after sanitization/);
});

test("buildBranchName: throws when topic is only whitespace", () => {
  assert.throws(() => buildBranchName(["PAP-001"], "   ", PATTERN), /empty after sanitization/);
});

test("buildBranchName: throws on non-git-ref-safe generated name", () => {
  assert.throws(
    () => buildBranchName(["PAP-001"], "topic", "feature/<ticket>-<topic>:bad"),
    /not git-ref-safe/,
  );
});

test("validateBranchName: matching single-ticket branch returns true", () => {
  assert.equal(validateBranchName("feature/PAP-001-fix-login", PATTERN), true);
});

test("validateBranchName: matching multi-ticket branch returns true", () => {
  assert.equal(validateBranchName("feature/PAP-001-PAP-002-shared-work", PATTERN), true);
});

test("validateBranchName: non-matching branch returns false", () => {
  assert.equal(validateBranchName("my-random-branch", PATTERN), false);
});

test("validateBranchName: bare main branch returns false", () => {
  assert.equal(validateBranchName("main", PATTERN), false);
});

test("validateBranchName: branch missing topic returns false", () => {
  assert.equal(validateBranchName("feature/PAP-001", PATTERN), false);
});

test("validateBranchName: branch with lowercase ticket id returns false", () => {
  assert.equal(validateBranchName("feature/pap-001-fix-login", PATTERN), false);
});

test("validateBranchName: custom pattern with path separator matches", () => {
  assert.equal(validateBranchName("feature/AVO-028/api-endpoints", "feature/<ticket>/<topic>"), true);
});

test("validateBranchName: custom pattern rejects non-matching", () => {
  assert.equal(validateBranchName("feature/AVO-028-api-endpoints", "feature/<ticket>/<topic>"), false);
});

test("validateBranchName: empty branch returns false", () => {
  assert.equal(validateBranchName("", PATTERN), false);
});