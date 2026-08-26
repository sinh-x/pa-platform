import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  QuestionDialogState,
  QuestionParams,
  boundQuestionText,
  createQuestionTool,
  type QuestionDialogResult,
  type QuestionInput,
} from "../pi-extension/question.js";

const OPTIONS = [
  { label: "Question", description: "Build the question tool" },
  { label: "Todo" },
  { label: "Context" },
];

function input(overrides: Partial<QuestionInput> = {}): QuestionInput {
  return { question: "Choose a target", header: "Scope", options: OPTIONS, ...overrides };
}

async function executeWithContext(
  value: QuestionInput,
  mode: "tui" | "rpc" | "json" | "print",
  custom: () => Promise<QuestionDialogResult | null>,
) {
  const tool = createQuestionTool();
  let customCalls = 0;
  const result = await tool.execute("question-call", value, undefined, undefined, {
    mode,
    ui: {
      custom: async () => {
        customCalls++;
        return custom();
      },
    },
  });
  return { result, customCalls };
}

test("question schema and registration retain Pi-style options and sequential execution", () => {
  const tool = createQuestionTool();
  assert.equal(Check(QuestionParams, input()), true);
  assert.equal(Check(QuestionParams, input({ multiple: true })), true);
  assert.equal(Check(QuestionParams, { question: "Missing options" }), false);
  assert.equal(Check(QuestionParams, input({ options: [{ label: "A", description: 42 } as never] })), false);
  assert.equal(tool.name, "question");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("single-select state returns exactly one predefined or custom answer", () => {
  const predefined = new QuestionDialogState(OPTIONS, false);
  predefined.move(1);
  assert.deepEqual(predefined.activate(), {
    answers: ["Todo"],
    selectedOptions: ["Todo"],
    customInput: null,
  });

  const custom = new QuestionDialogState(OPTIONS, false);
  custom.move(1);
  custom.move(1);
  custom.move(1);
  assert.equal(custom.activate(), "edit");
  assert.deepEqual(custom.submitCustom("  Deployment view  "), {
    answers: ["Deployment view"],
    selectedOptions: [],
    customInput: "Deployment view",
  });
});

test("multi-select state combines unique predefined answers with at most one custom value", () => {
  const state = new QuestionDialogState(OPTIONS, true);
  assert.equal(state.activate(), null);
  assert.equal(state.activate(), null); // toggled off
  assert.equal(state.activate(), null); // toggled on once
  state.move(1);
  state.move(1);
  assert.equal(state.activate(), null);
  state.move(1);
  assert.equal(state.activate(), "edit");
  assert.equal(state.submitCustom("Git freshness"), null);
  assert.equal(state.activate(), "edit");
  assert.equal(state.submitCustom("Question"), null); // replaces the prior custom value
  state.move(1);
  assert.deepEqual(state.activate(), {
    answers: ["Question", "Context"],
    selectedOptions: ["Question", "Context"],
    customInput: "Question",
  });
});

test("multi-select permits an explicit empty submission", () => {
  const state = new QuestionDialogState(OPTIONS, true);
  for (let index = 0; index < OPTIONS.length + 1; index++) state.move(1);
  assert.deepEqual(state.activate(), { answers: [], selectedOptions: [], customInput: null });
});

test("JSON, print, and RPC modes return typed UI-unavailable results without custom UI", async () => {
  for (const mode of ["json", "print", "rpc"] as const) {
    const { result, customCalls } = await executeWithContext(input(), mode, async () => {
      throw new Error("custom UI must not run");
    });
    assert.equal(customCalls, 0);
    assert.equal(result.details.outcome, "ui_unavailable");
    assert.equal(result.details.unavailable, true);
    assert.equal(result.details.cancelled, false);
    assert.deepEqual(result.details.answers, []);
  }
});

test("TUI answers and cancellation produce distinct typed outcomes", async () => {
  const answered = await executeWithContext(input({ multiple: true }), "tui", async () => ({
    answers: ["Question", "Context", "Git freshness"],
    selectedOptions: ["Question", "Context"],
    customInput: "Git freshness",
  }));
  assert.equal(answered.customCalls, 1);
  assert.equal(answered.result.details.outcome, "answered");
  assert.deepEqual(answered.result.details.answers, ["Question", "Context", "Git freshness"]);
  assert.equal(answered.result.details.customInput, "Git freshness");

  const cancelled = await executeWithContext(input(), "tui", async () => null);
  assert.equal(cancelled.customCalls, 1);
  assert.equal(cancelled.result.details.outcome, "cancelled");
  assert.equal(cancelled.result.details.cancelled, true);
  assert.deepEqual(cancelled.result.details.answers, []);
});

test("empty options are rejected before opening custom UI", async () => {
  const { result, customCalls } = await executeWithContext(input({ options: [] }), "tui", async () => null);
  assert.equal(customCalls, 0);
  assert.equal(result.details.outcome, "validation_error");
  assert.match(result.details.error ?? "", /at least one/i);
});

test("question textual output stays within the shared 50 KiB and 2,000-line limits", async () => {
  const huge = `${"x".repeat(60_000)}\n${Array.from({ length: 2_100 }, () => "line").join("\n")}`;
  const { result } = await executeWithContext(input(), "tui", async () => ({
    answers: [huge],
    selectedOptions: [],
    customInput: huge,
  }));
  const text = result.content[0]!.text;
  assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024);
  assert.ok(text.split("\n").length <= 2_000);
  assert.match(text, /truncated question result/);
  assert.match(boundQuestionText(huge), /truncated question result/);
});
