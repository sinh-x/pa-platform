/*
 * Adapted from the MIT-licensed Pi 0.80.8 question extension example:
 * examples/extensions/question.ts
 *
 * Intentional PA changes: optional header, single/multi-select modes,
 * combinable custom input, typed outcomes, and bounded textual results.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { PiExtensionModule, PiToolDefinition } from "./index.js";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInput extends Record<string, unknown> {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export type QuestionOutcome = "answered" | "cancelled" | "ui_unavailable" | "validation_error";

export interface QuestionDetails extends Record<string, unknown> {
  outcome: QuestionOutcome;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple: boolean;
  answers: string[];
  selectedOptions: string[];
  customInput: string | null;
  cancelled: boolean;
  unavailable: boolean;
  error?: string;
}

export interface QuestionDialogResult {
  answers: string[];
  selectedOptions: string[];
  customInput: string | null;
}

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below the label" })),
});

export const QuestionParams = Type.Object({
  question: Type.String({ description: "Question to ask the user" }),
  header: Type.Optional(Type.String({ description: "Optional short dialog header" })),
  options: Type.Array(OptionSchema, { description: "Predefined options presented in order" }),
  multiple: Type.Optional(Type.Boolean({ default: false, description: "Allow multiple predefined answers plus custom input" })),
});

export class QuestionDialogState {
  readonly optionCount: number;
  readonly multiple: boolean;
  cursor = 0;
  editingCustom = false;
  customInput: string | null = null;
  private readonly selected = new Set<number>();
  private readonly labels: string[];

  constructor(options: QuestionOption[], multiple: boolean) {
    this.labels = options.map((option) => option.label);
    this.optionCount = options.length;
    this.multiple = multiple;
  }

  get rowCount(): number {
    return this.optionCount + 1 + (this.multiple ? 1 : 0);
  }

  get customRow(): number {
    return this.optionCount;
  }

  get submitRow(): number | null {
    return this.multiple ? this.optionCount + 1 : null;
  }

  isSelected(index: number): boolean {
    return this.selected.has(index);
  }

  move(delta: -1 | 1): void {
    this.cursor = Math.max(0, Math.min(this.rowCount - 1, this.cursor + delta));
  }

  activate(): QuestionDialogResult | "edit" | null {
    if (this.cursor < this.optionCount) {
      if (!this.multiple) {
        return this.result([this.cursor]);
      }
      if (this.selected.has(this.cursor)) this.selected.delete(this.cursor);
      else this.selected.add(this.cursor);
      return null;
    }

    if (this.cursor === this.customRow) {
      this.editingCustom = true;
      return "edit";
    }

    return this.buildResult();
  }

  submitCustom(value: string): QuestionDialogResult | null {
    const trimmed = value.trim();
    this.editingCustom = false;
    this.customInput = trimmed || null;
    if (!trimmed || this.multiple) return null;
    return this.buildResult();
  }

  cancelCustom(): void {
    this.editingCustom = false;
  }

  buildResult(): QuestionDialogResult {
    return this.result([...this.selected].sort((left, right) => left - right));
  }

  private result(indices: number[]): QuestionDialogResult {
    const selectedOptions = [...new Set(indices.map((index) => this.labels[index]).filter((label): label is string => label !== undefined))];
    const answers = [...selectedOptions];
    if (this.customInput && !answers.includes(this.customInput)) answers.push(this.customInput);
    return { answers, selectedOptions, customInput: this.customInput };
  }
}

interface QuestionExecutionContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: {
    custom<TResult>(factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: TResult) => void) => Component): Promise<TResult>;
  };
}

class QuestionDialogComponent implements Component, Focusable {
  private readonly state: QuestionDialogState;
  private readonly editor: Editor;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly input: QuestionInput,
    private readonly done: (result: QuestionDialogResult | null) => void,
  ) {
    this.state = new QuestionDialogState(input.options, input.multiple ?? false);
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.onSubmit = (value) => {
      const result = this.state.submitCustom(value);
      this.editor.setText("");
      if (result) this.done(result);
      else this.refresh();
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    if (this.state.editingCustom) {
      if (matchesKey(data, Key.escape)) {
        this.state.cancelCustom();
        this.editor.setText("");
      } else {
        this.editor.handleInput(data);
      }
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.up)) this.state.move(-1);
    else if (matchesKey(data, Key.down)) this.state.move(1);
    else if (matchesKey(data, Key.space) && this.state.cursor < this.state.optionCount && this.state.multiple) this.state.activate();
    else if (matchesKey(data, Key.enter)) {
      const result = this.state.activate();
      if (result === "edit") this.editor.setText(this.state.customInput ?? "");
      else if (result) this.done(result);
    } else if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    } else {
      return;
    }
    this.refresh();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    const addWrapped = (prefix: string, text: string) => {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= renderWidth) {
        lines.push(truncateToWidth(prefix + text, renderWidth));
        return;
      }
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      const continuation = " ".repeat(prefixWidth);
      wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : continuation}${line}`));
    };

    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
    if (this.input.header) addWrapped(" ", this.theme.fg("accent", this.theme.bold(this.input.header)));
    addWrapped(" ", this.theme.fg("text", this.input.question));
    lines.push("");

    for (let index = 0; index < this.input.options.length; index++) {
      const option = this.input.options[index]!;
      const active = index === this.state.cursor;
      const prefix = active ? this.theme.fg("accent", "> ") : "  ";
      const check = this.state.multiple ? (this.state.isSelected(index) ? "[x] " : "[ ] ") : `${index + 1}. `;
      addWrapped(prefix, this.theme.fg(active ? "accent" : "text", `${check}${option.label}`));
      if (option.description) addWrapped("     ", this.theme.fg("muted", option.description));
    }

    const customActive = this.state.cursor === this.state.customRow;
    const customPrefix = customActive ? this.theme.fg("accent", "> ") : "  ";
    const customCheck = this.state.multiple ? (this.state.customInput ? "[x] " : "[ ] ") : `${this.input.options.length + 1}. `;
    const customLabel = this.state.customInput ? `Custom: ${this.state.customInput}` : "Type something.";
    addWrapped(customPrefix, this.theme.fg(customActive ? "accent" : "text", `${customCheck}${customLabel}`));

    if (this.state.submitRow !== null) {
      const submitActive = this.state.cursor === this.state.submitRow;
      const prefix = submitActive ? this.theme.fg("accent", "> ") : "  ";
      addWrapped(prefix, this.theme.fg(submitActive ? "accent" : "text", `Submit (${this.state.buildResult().answers.length} selected)`));
    }

    if (this.state.editingCustom) {
      lines.push("");
      addWrapped(" ", this.theme.fg("muted", "Custom answer:"));
      for (const line of this.editor.render(Math.max(1, renderWidth - 2))) lines.push(truncateToWidth(` ${line}`, renderWidth));
    }

    lines.push("");
    const help = this.state.editingCustom
      ? "Enter to save • Esc to go back"
      : this.state.multiple
        ? "↑↓ navigate • Space/Enter toggle • Submit row confirms • Esc cancels"
        : "↑↓ navigate • Enter selects • Esc cancels";
    addWrapped(" ", this.theme.fg("dim", help));
    lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));

    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, renderWidth));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  private refresh(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }
}

export function createQuestionTool(): PiToolDefinition<QuestionInput, QuestionDetails> {
  return {
    name: "question",
    label: "Question",
    description: "Ask the user a structured single-select or multi-select question with optional custom input. Text output is bounded to 50 KiB and 2,000 lines.",
    promptSnippet: "Ask the user a structured question when input is required to proceed",
    promptGuidelines: ["Use question when a decision requires direct user input; do not guess the answer."],
    parameters: QuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, input, _signal, _onUpdate, rawContext) {
      const multiple = input.multiple ?? false;
      const base = {
        question: input.question,
        ...(input.header ? { header: input.header } : {}),
        options: input.options.map((option) => ({ ...option })),
        multiple,
        answers: [],
        selectedOptions: [],
        customInput: null,
        cancelled: false,
        unavailable: false,
      };

      if (input.options.length === 0) {
        const details: QuestionDetails = { ...base, outcome: "validation_error", error: "At least one predefined option is required." };
        return { content: [{ type: "text", text: "Question rejected: at least one predefined option is required." }], details };
      }

      const context = rawContext as QuestionExecutionContext;
      if (context.mode !== "tui") {
        const details: QuestionDetails = { ...base, outcome: "ui_unavailable", unavailable: true };
        return { content: [{ type: "text", text: `Question unavailable in ${context.mode} mode; no terminal interaction was attempted.` }], details };
      }

      const result = await context.ui.custom<QuestionDialogResult | null>((tui, theme, _keybindings, done) =>
        new QuestionDialogComponent(tui, theme, input, done));

      if (!result) {
        const details: QuestionDetails = { ...base, outcome: "cancelled", cancelled: true };
        return { content: [{ type: "text", text: "User cancelled the question." }], details };
      }

      const details: QuestionDetails = {
        ...base,
        outcome: "answered",
        answers: result.answers,
        selectedOptions: result.selectedOptions,
        customInput: result.customInput,
      };
      const answerText = result.answers.length > 0 ? result.answers.join(", ") : "(no answers selected)";
      return { content: [{ type: "text", text: boundQuestionText(`User answered: ${answerText}`) }], details };
    },

    renderCall(args, theme) {
      const heading = args.header ? `${args.header}: ` : "";
      const mode = args.multiple ? "multiple" : "single";
      return new Text(
        theme.fg("toolTitle", theme.bold("question ")) +
          theme.fg("muted", `${heading}${args.question}`) +
          `\n${theme.fg("dim", `  ${mode} • ${args.options.length} option(s) + custom`)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details;
      if (details.outcome === "ui_unavailable") return new Text(theme.fg("warning", "UI unavailable"), 0, 0);
      if (details.outcome === "validation_error") return new Text(theme.fg("error", `Error: ${details.error ?? "invalid question"}`), 0, 0);
      if (details.outcome === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      const answer = details.answers.length > 0 ? details.answers.join(", ") : "No answers selected";
      const custom = details.customInput ? theme.fg("muted", " (includes custom input)") : "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", answer) + custom, 0, 0);
    },
  };
}

export const registerQuestionModule: PiExtensionModule = (pi) => {
  pi.registerTool?.(createQuestionTool());
};

export function boundQuestionText(text: string): string {
  const truncated = truncateHead(text, {
    maxBytes: Math.max(1, DEFAULT_MAX_BYTES - 256),
    maxLines: Math.max(1, DEFAULT_MAX_LINES - 1),
  });
  if (!truncated.truncated) return text;
  return `${truncated.content}\n...[truncated question result: ${truncated.outputLines} of ${truncated.totalLines} lines, ${truncated.outputBytes} of ${truncated.totalBytes} bytes]`;
}
