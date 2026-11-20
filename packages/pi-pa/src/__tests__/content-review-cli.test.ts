import assert from "node:assert/strict";
import { test } from "node:test";
import { runDocumentCommand } from "../document-cli.js";
import type { LocalReviewHandler } from "../local-review-cli.js";

const reference = `review:${"a".repeat(64)}`;
function fixture() {
  const stdout: string[] = [], stderr: string[] = [], actions: string[] = [];
  let outcome: string | undefined;
  const handler: LocalReviewHandler = async raw => {
    const request: unknown = JSON.parse(raw);
    assert.ok(request && typeof request === "object" && "action" in request && typeof request.action === "string");
    actions.push(request.action);
    assert.equal("expectedRevision" in request, false); assert.equal("requestKey" in request, false);
    if (request.action === "list") return { reviews: [{ reference, packageId: "fixture", revision: 3 }] };
    if (request.action === "request") return outcome ? { outcome, decisionId: "saved" } : { status: "pending" };
    if (request.action === "decide") {
      assert.ok("outcome" in request && typeof request.outcome === "string"); outcome = request.outcome;
      return { outcome, decisionId: "saved" };
    }
    return { document: { ticket: "EX-1", packageId: "fixture", revision: 3 }, approval: outcome ?? "pending", actionable: !outcome,
      documents: [{ id: "brief", content: "Full brief" }, { id: "requirements", content: "Complete requirements" }, { id: "uat", content: "Complete UAT" }],
      presentation: { manifest: "exact manifest", outputs: ["full reader", "standalone members", "exact raw"] } };
  };
  return { stdout, stderr, actions, handler, io: { stdout: (value: string) => { stdout.push(value); }, stderr: (value: string) => { stderr.push(value); } },
    external(value: string) { outcome = value; } };
}

test("guided ticket discovery copies a reference and never chooses latest or prompts", async () => {
  const f = fixture();
  assert.equal(await runDocumentCommand(["review", "list", "EX-1"], f.io, { contentHandler: f.handler, prompt: async () => { throw Error("must not prompt"); } }), 0);
  assert.match(f.stdout.join("\n"), new RegExp(reference)); assert.deepEqual(f.actions, ["list"]);
  assert.match(f.stdout.join("\n"), /No revision was selected/);
});
for (const [input, expected] of [["a", "approved"], ["c", "changes-requested"], ["r", "rejected"], ["", "cancelled"], [undefined, undefined]] as const) {
  test(`guided choice ${String(input)} follows full verified delivery; disconnect never Cancels`, async () => {
    const f = fixture();
    assert.equal(await runDocumentCommand(["review", reference], f.io, { contentHandler: f.handler, prompt: async () => {
      assert.match(f.stdout.join("\n"), /Complete requirements/); assert.match(f.stdout.join("\n"), /Complete UAT/); assert.match(f.stdout.join("\n"), /manifest/);
      return input;
    } }), 0);
    assert.equal(f.actions.includes("decide"), expected !== undefined);
    assert.match(f.stdout.join("\n"), expected === "approved" ? /Approved · Not published/ : expected === undefined ? /request remains pending/ : /Not published/);
    const previous = f.actions.length;
    if (expected) {
      assert.equal(await runDocumentCommand(["review", reference], f.io, { contentHandler: f.handler, prompt: async () => { throw Error("duplicate prompt"); } }), 0);
      assert.deepEqual(f.actions.slice(previous), ["request"]);
    }
  });
}

test("guided external decision closes pending input and converges without compensating Cancel", async () => {
  const f = fixture(); let aborted = false;
  const result = await runDocumentCommand(["review", reference], f.io, { contentHandler: f.handler, prompt: signal => new Promise(resolve => {
    f.external("approved"); signal.addEventListener("abort", () => { aborted = true; resolve(undefined); }, { once: true });
  }) });
  assert.equal(result, 0); assert.equal(aborted, true); assert.equal(f.actions.includes("decide"), false);
  assert.match(f.stdout.join("\n"), /Approved · Not published/);
});

test("unverified delivery is nonactionable and hostile exceptions stay private in bounded plain blockers", async () => {
  for (const mode of ["unverified", "exception"]) {
    const f = fixture();
    const handler: LocalReviewHandler = async raw => {
      if (mode === "exception") throw new Proxy({}, { get() { throw Error("PRIVATE_SYNTHETIC"); } });
      const result = await f.handler(raw); return { ...result, actionable: false };
    };
    assert.equal(await runDocumentCommand(["review", reference], f.io, { contentHandler: handler, prompt: async () => { throw Error("must not prompt"); } }), 1);
    assert.equal(f.actions.includes("decide"), false);
    const output = f.stderr.join("\n"); assert.ok(output.length <= 2000); assert.doesNotMatch(output, /PRIVATE_SYNTHETIC/);
    for (const label of ["Condition:", "Source:", "Reason:", "Correction:", "Resume Action:"]) assert.equal(output.split(label).length - 1, 1);
  }
});
