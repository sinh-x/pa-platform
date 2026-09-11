import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerPiVimMode from "../../vendor/pi-vimmode/index.ts";
import registerProperBase from "../../vendor/proper-pi-extensions/proper-base/index.ts";
import {
  createPiPaModules,
  createPiSessionLifecycle,
  registerPiSessionModules,
} from "../pi-extension/index.js";
import type { BundledEditorFactory } from "../pi-extension/bundled-editors.js";
import {
  FakeComposedHost,
  FakeComposedTui,
  FakeComposedUi,
  FakeKeybindings,
  createHostContext,
  type ComposedEditor,
  type EditorFactory,
} from "./fixtures/pi-composed-host.js";

const PROPER_WRAPPED = Symbol.for("pi-proper-history.wrapped");
const TRANSCRIPT_CLEANUP = Symbol.for("pi-proper-base.transcript-cleanup");
type ScheduledCallback = () => void;

const VIM_FACTORY: BundledEditorFactory = { name: "pi-vimmode", version: "0.9.0", register: registerPiVimMode };
const PROPER_FACTORY: BundledEditorFactory = { name: "proper-base", version: "0.5.0", register: registerProperBase };
const BOTH_EDITOR_MODULES = createPiPaModules([VIM_FACTORY, PROPER_FACTORY]);

async function captureScheduled(run: () => Promise<void>): Promise<ScheduledCallback[]> {
  const scheduled: ScheduledCallback[] = [];
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    scheduled.push(() => callback(...args));
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setTimeout;
  try {
    await run();
  } finally {
    globalThis.setTimeout = original;
  }
  return scheduled;
}

function editorTheme(): Record<string, unknown> {
  const identity = (text: string): string => text;
  return {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      noMatch: identity,
      scrollInfo: identity,
    },
  };
}

function seedHistory(agentDir: string, cwd: string, text: string): void {
  const key = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const directory = join(agentDir, "proper-history");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${key}.jsonl`), `${JSON.stringify({ t: text, ts: 1 })}\n`);
}

function assertOneProperOverVim(factory: EditorFactory | undefined, expectVim = true): EditorFactory {
  assert.equal(typeof factory, "function");
  assert.equal(PROPER_WRAPPED in factory, true, "proper-base must remain the outer editor wrapper");
  const vimFactory = (factory as unknown as Record<symbol, unknown>)[PROPER_WRAPPED];
  if (expectVim) {
    assert.equal(typeof vimFactory, "function", "the proper-base wrapper must contain Vim");
    assert.equal(PROPER_WRAPPED in vimFactory, false, "the editor chain must contain exactly one proper-base wrapper");
  } else assert.equal(vimFactory, null, "Vim off must restore the native editor under proper-base");
  assert.notEqual(vimFactory, factory, "the editor chain must not wrap itself");
  return factory;
}

async function exerciseRepresentativeDefaults(
  host: FakeComposedHost,
  context: ReturnType<typeof createHostContext>,
  editor: ComposedEditor,
): Promise<void> {
  assert.equal(editor.getVimMode(), "insert");
  editor.setText("abc\ndef");
  editor.handleInput("\x1b");
  assert.equal(editor.getVimMode(), "normal");
  assert.deepEqual(editor.getCursor(), { line: 1, col: 3 });
  editor.handleInput("h");
  assert.deepEqual(editor.getCursor(), { line: 1, col: 2 });
  editor.handleInput("k");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
  editor.handleInput("h");
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
  editor.handleInput("j");
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 });
  editor.handleInput("x");
  assert.equal(editor.getText(), "abc\ndf");
  editor.handleInput("i");
  editor.handleInput("!");
  assert.equal(editor.getVimMode(), "insert");
  assert.match(editor.getText(), /!/);

  const vimMode = host.commands.get("vimmode");
  assert.ok(vimMode);
  await vimMode.handler("status", context);
  assert.deepEqual(context.ui.notifications.at(-1), ["pi-vimmode enabled", "info"]);
  await vimMode.handler("off", context);
  assertOneProperOverVim(context.ui.component, false);
  assert.equal(context.ui.statuses.get("pi-vimmode"), "vim off");
  await vimMode.handler("on", context);
  assertOneProperOverVim(context.ui.component);
  assert.equal(context.ui.statuses.get("pi-vimmode"), "vim");
  await vimMode.handler("reload", context);
  assertOneProperOverVim(context.ui.component);
  assert.deepEqual(context.ui.notifications.at(-1), ["pi-vimmode reloaded", "info"]);

  const clear = host.commands.get("clear");
  const restore = host.commands.get("__proper-restore-model");
  assert.ok(clear);
  assert.ok(restore);
  const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
  let restoreMessage = "";
  await clear.handler("", {
    ...context,
    model,
    newSession: async (options: unknown) => {
      const withSession = (options as { withSession: (replacement: unknown) => Promise<void> }).withSession;
      await withSession({ sendUserMessage: async (text: string) => { restoreMessage = text; } });
      return { cancelled: false };
    },
  });
  assert.match(restoreMessage, /^\/__proper-restore-model /);
  const encodedModel = restoreMessage.slice(restoreMessage.indexOf(" ") + 1);
  await restore.handler(encodedModel, {
    ...context,
    modelRegistry: { find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined },
  });
  assert.equal(host.selectedModel, model);

  const titlePrompt = (await host.dispatch("before_agent_start", { systemPrompt: "base" }, context))
    .find((result): result is { systemPrompt: string } => Boolean(result && typeof result === "object" && "systemPrompt" in result));
  assert.match(titlePrompt?.systemPrompt ?? "", /<session_title>/);
  await host.dispatch("message_end", {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Done.\n<session_title>Composed editor chain</session_title>" }],
    },
  }, context);
  assert.equal(host.sessionName, "Composed editor chain");
  assert.equal(host.markdownTransformers[0]?.("Done.\n<session_title>Hidden</session_title>", { messageType: "assistant", isStreaming: false }), "Done.");

  const oldUser = { role: "user", content: [{ type: "text", text: "old" }, { type: "image", data: "old-image" }] };
  const currentUser = { role: "user", content: [{ type: "text", text: "current" }] };
  const transformed = (await host.dispatch("context", { messages: [oldUser, currentUser] }, context))
    .find((result): result is { messages: Array<{ content: Array<{ type: string; text?: string }> }> } => Boolean(result && typeof result === "object" && "messages" in result));
  assert.equal(transformed?.messages[0]?.content[1]?.type, "text");
  assert.match(transformed?.messages[0]?.content[1]?.text ?? "", /image omitted/);
  assert.equal(oldUser.content[1]?.type, "image", "context transforms must not mutate stored messages");

  const commitResults = await host.dispatch("tool_call", { toolName: "bash", input: { command: "git commit -F /tmp/message" } }, context);
  assert.ok(commitResults.some((result) => Boolean(result && typeof result === "object" && "block" in result)));
  const destructiveResults = await host.dispatch("tool_call", { toolName: "bash", input: { command: "rm -rf build" } }, context);
  assert.ok(destructiveResults.some((result) => Boolean(result && typeof result === "object" && "block" in result)));
}

test("4/4 editor selections preserve non-editor modules and register no unselected behavior", async () => {
  const matrix: Array<{
    name: string;
    factories: readonly BundledEditorFactory[];
    vim: boolean;
    proper: boolean;
  }> = [
    { name: "neither", factories: [], vim: false, proper: false },
    { name: "Vim only", factories: [VIM_FACTORY], vim: true, proper: false },
    { name: "proper-base only", factories: [PROPER_FACTORY], vim: false, proper: true },
    { name: "both", factories: [VIM_FACTORY, PROPER_FACTORY], vim: true, proper: true },
  ];

  for (const selection of matrix) {
    const root = mkdtempSync(join(tmpdir(), "pi-pa-selection-host-"));
    const host = new FakeComposedHost();
    const ui = new FakeComposedUi();
    const context = createHostContext("tui", root, ui);
    let registryCloses = 0;
    try {
      registerPiSessionModules(
        host.runtime,
        createPiSessionLifecycle(() => { registryCloses += 1; }),
        createPiPaModules(selection.factories),
      );
      assert.deepEqual([...host.tools.keys()], ["pa_ticket", "pa_bulletin", "pa_registry", "pa_status", "question", "todo"], `${selection.name}: PA tools`);
      assert.deepEqual(host.shortcuts, ["alt+i", "alt+g"], `${selection.name}: context shortcuts`);
      assert.equal(host.commands.has("vimmode"), selection.vim, `${selection.name}: Vim command selection`);
      for (const command of ["fast-global", "__proper-restore-model", "clear", "__proper-cancel-prompt"]) {
        assert.equal(host.commands.has(command), selection.proper, `${selection.name}: proper-base command ${command}`);
      }
      assert.ok(host.commands.has("pa-context"), `${selection.name}: context UI command`);
      assert.ok(host.commands.has("pa-git-context"), `${selection.name}: Git context UI command`);
      const safety = await host.dispatch("tool_call", { toolName: "bash", input: { command: "rm -rf build" } }, context);
      assert.ok(safety.some((result) => Boolean(result && typeof result === "object" && "block" in result)), `${selection.name}: safety guard`);

      const scheduled = await captureScheduled(async () => {
        await host.dispatch("session_start", { type: "session_start", reason: "startup" }, context);
        await host.dispatch("resources_discover", { type: "resources_discover", reason: "startup" }, context);
      });
      if (selection.proper) assertOneProperOverVim(ui.component, selection.vim);
      else if (selection.vim) {
        assert.equal(typeof ui.component, "function", `${selection.name}: Vim factory installed`);
        assert.equal(PROPER_WRAPPED in ui.component!, false, `${selection.name}: no proper-base wrapper`);
      } else assert.equal(ui.component, undefined, `${selection.name}: native editor retained`);

      await host.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
      assert.equal(registryCloses, 1, `${selection.name}: one registry close`);
      for (const callback of scheduled) callback();
      assert.equal(ui.terminalInputHandlers.size, 0, `${selection.name}: terminal handlers cleaned`);
      assert.equal(host.handlers.get("session_shutdown")?.length, 1, `${selection.name}: one central shutdown handler`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("bundled factories keep one proper-base-over-Vim chain across repeated Pi lifecycle replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-pa-composed-host-"));
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = join(root, "agent");
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const ui = new FakeComposedUi();
  const tui = new FakeComposedTui();
  const originalFooterRender = tui.footer.render;
  const historyPrompt = "project history survives replacement";
  seedHistory(agentDir, root, historyPrompt);

  try {
    for (const reason of ["startup", "reload", "new", "resume", "fork", "quit"] as const) {
      const host = new FakeComposedHost();
      let registryCloses = 0;
      registerPiSessionModules(host.runtime, createPiSessionLifecycle(() => { registryCloses += 1; }), BOTH_EDITOR_MODULES);
      const context = createHostContext("tui", root, ui);
      const scheduled = await captureScheduled(async () => {
        await host.dispatch("session_start", { type: "session_start", reason }, context, 2);
        await host.dispatch("resources_discover", { type: "resources_discover", reason }, context);
      });

      assert.equal(host.handlers.get("session_shutdown")?.length, 1, `${reason}: one central shutdown boundary`);
      const factory = assertOneProperOverVim(ui.component);
      const editor = factory(tui, editorTheme(), new FakeKeybindings());
      assert.equal(editor.getVimMode(), "insert");
      editor.render(80);
      assert.equal(tui.hardwareCursorVisible, true, `${reason}: active Vim editor owns one hardware cursor state`);
      assert.equal(Object.hasOwn(tui.footer, "render"), true, `${reason}: proper footer wrapper installed`);
      assert.equal(TRANSCRIPT_CLEANUP in tui.chat, true, `${reason}: transcript cleanup installed`);
      assert.equal(ui.terminalInputHandlers.size, 1, `${reason}: one proper terminal-input handler`);
      assert.equal(tui.overlayCount, 0);

      if (reason === "startup") {
        editor.setText("");
        editor.handleInput("\x1b[A");
        assert.equal(editor.getText(), historyPrompt);
        await exerciseRepresentativeDefaults(host, context, editor);
      }

      const assignmentsBeforeShutdown = ui.editorAssignments.length;
      await host.dispatch("session_shutdown", { type: "session_shutdown", reason }, context);
      assert.equal(registryCloses, 1, `${reason}: registry closes after extension disposal`);
      assert.equal(Object.hasOwn(tui.footer, "render"), false, `${reason}: footer wrapper disposed`);
      assert.equal(tui.footer.render, originalFooterRender);
      assert.equal(TRANSCRIPT_CLEANUP in tui.chat, false, `${reason}: transcript cleanup disposed`);
      assert.equal(ui.terminalInputHandlers.size, 0, `${reason}: terminal handlers disposed`);
      assert.equal(tui.inputListeners.size, 0, `${reason}: TUI listeners disposed`);
      assert.equal(tui.hardwareCursorVisible, reason === "quit", `${reason}: cursor state disposed with upstream quit visibility semantics`);
      assert.equal(tui.overlayCount, 0, `${reason}: overlays disposed`);
      for (const callback of scheduled.splice(0)) callback();
      assert.equal(scheduled.length, 0, `${reason}: delayed installs settled`);
      assert.equal(ui.editorAssignments.length, assignmentsBeforeShutdown, `${reason}: stale timer cannot reinstall an editor`);
      assertOneProperOverVim(ui.component);
      assert.equal(ui.terminalInputHandlers.size, 0, `${reason}: no stale proper-base handler remains`);
      assert.equal(tui.inputListeners.size, 0, `${reason}: no stale editor listener remains`);
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("print and JSON hosts load the composition without opening TUI-only components", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-pa-noninteractive-host-"));
  try {
    for (const mode of ["print", "json"] as const) {
      const host = new FakeComposedHost();
      registerPiSessionModules(host.runtime, createPiSessionLifecycle(() => {}), BOTH_EDITOR_MODULES);
      const context = createHostContext(mode, root);
      await host.dispatch("session_start", { type: "session_start", reason: "startup" }, context, 2);
      await host.dispatch("resources_discover", { type: "resources_discover", reason: "startup" }, context);
      await host.dispatch("agent_end", { messages: [] }, context);
      assert.equal(context.ui.editorAssignments.length, 0, `${mode}: no editor factory installation`);
      assert.equal(context.ui.customOpenCount, 0, `${mode}: no custom component opening`);
      assert.equal(context.ui.terminalInputHandlers.size, 0, `${mode}: no terminal input handler`);
      assert.ok(host.commands.has("vimmode"));
      assert.ok(host.commands.has("clear"));
      assert.deepEqual([...host.tools.keys()], ["pa_ticket", "pa_bulletin", "pa_registry", "pa_status", "question", "todo"]);
      const safety = await host.dispatch("tool_call", { toolName: "bash", input: { command: "rm -rf build" } }, context);
      assert.ok(safety.some((result) => Boolean(result && typeof result === "object" && "block" in result)));
      await host.dispatch("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
