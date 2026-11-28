import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, TuiMainScreen } from "@earendil-works/pi-tui";
import { ContextSidebarComponent, formatTicketLines } from "../pi-extension/context-ui.js";
import { initialContextSnapshot } from "../pi-extension/context-state.js";
import { readerContextOverlayOptions, contextOverlayOptions } from "../pi-extension/context-overlay-layout.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function fixture() {
  const snapshot = initialContextSnapshot({ cwd: "/repo" }, { env: { PA_DEPLOYMENT_ID: "d-test" } });
  snapshot.deployment = { ...snapshot.deployment, projectionAvailable: true, project: "example", ticket: "EX-001",
    objective: "MULTILINE\n" + "界 é 👩‍💻 ".repeat(45) + "OBJECTIVE-TAIL\n" + "x".repeat(150) + "WORD-TAIL" };
  snapshot.todo.tasks = [1, 2].map(id => ({ id, text: "LONG-TASK " + "words ".repeat(50) + `TASK-${id}-TAIL`, order: id, status: "pending" as const, dependencies: [] }));
  return snapshot;
}

test("100-column short-height viewport reaches multiline, Unicode, long-word and task tails in order", () => {
  const snapshot = fixture();
  const terminal = { columns: 100, rows: 12 };
  const component = new ContextSidebarComponent({ terminal, requestRender() {} } as never, theme as never, () => snapshot, () => {});
  const frames: string[] = [];
  for (let i = 0; i < 100; i++) {
    const lines = component.render(68);
    assert.ok(lines.length <= Math.floor(terminal.rows * .9));
    for (const line of lines) assert.ok(visibleWidth(line) <= 68);
    frames.push(lines.join("\n"));
    component.handleInput("\x1b[6~");
  }
  const joined = frames.join("\n");
  for (const token of ["OBJECTIVE-TAIL", "WORD-TAIL", "TASK-1-TAIL", "TASK-2-TAIL"]) assert.ok(joined.includes(token), token);
  assert.ok(joined.indexOf("OBJECTIVE-TAIL") < joined.indexOf("TASK-1-TAIL"));
  assert.match(frames.at(-1)!, /TASK-2-TAIL/);
  terminal.rows = 7;
  assert.ok(component.render(68).length <= 6, "resize changes cached height and clamps viewport");
});

test("tabs preserve independent scroll; focused retry, Escape, and 99-column editing guards", () => {
  const snapshot = fixture(), terminal = { columns: 120, rows: 14 };
  let focused = true, retries = 0, hides = 0;
  const tabs: string[] = [];
  const component = new ContextSidebarComponent({ terminal, requestRender() {} } as never, theme as never, () => snapshot, () => { hides++; }, {
    onTab: tab => tabs.push(tab), retry: () => { retries++; }, isFocused: () => focused,
    getTicketState: () => ({ status: "unavailable" }),
  });
  component.render(80); component.handleInput("\x1b[F");
  const end = component.render(80);
  assert.match(end.join("\n"), /TASK-2-TAIL/);
  component.handleInput("r"); assert.equal(retries, 0);
  component.handleInput("\t"); component.render(80); component.handleInput("r");
  assert.equal(retries, 1); assert.match(component.render(80).join("\n"), /EX-001/);
  component.handleInput("\t"); assert.deepEqual(component.render(80), end);
  focused = false; component.handleInput("\t"); component.handleInput("\x1b");
  assert.equal(hides, 0); assert.equal(component.activeTab, "context");
  focused = true; terminal.columns = 99; component.handleInput("\t"); component.handleInput("r"); component.handleInput("\x1b");
  assert.equal(hides, 0); assert.equal(retries, 1);
  terminal.columns = 100; component.handleInput("\x1b"); assert.equal(hides, 1);
  assert.deepEqual(tabs, ["ticket", "context"]);
});

test("only the Context threshold changes: 100/119/120 reader, still 120 for Git", () => {
  for (const width of [99, 100, 119, 120]) {
    assert.equal(readerContextOverlayOptions().visible!(width, 24), width >= 100);
    assert.equal(contextOverlayOptions().visible!(width, 24), width >= 120);
  }
  assert.equal(readerContextOverlayOptions().visible!(120, 5), false);
});

test("ticket rendering withholds foreign/stale bodies and displays matching safe fields with read time", () => {
  const snapshot = fixture();
  const ticket = { id: "EX-001", project: "example", title: "Title", status: "idea" as const, priority: "medium" as const, assignee: "", summary: "Summary", description: "Description" };
  const state = { status: "ready" as const, ticket, readAt: 42 };
  assert.match(formatTicketLines(snapshot, state).join("\n"), /1970-01-01T00:00:00.042Z/);
  assert.doesNotMatch(formatTicketLines(snapshot, { ...state, ticket: { ...ticket, id: "EX-002", description: "FOREIGN" } }).join("\n"), /FOREIGN/);
  snapshot.deployment.projectionAvailable = false;
  assert.doesNotMatch(formatTicketLines(snapshot, state).join("\n"), /Description/);
});

test("rendered over-budget text has explicit truncation and literal controls only", () => {
  const snapshot = fixture(); snapshot.deployment.objective = "o".repeat(17_000) + "OVER-BUDGET";
  const component = new ContextSidebarComponent({ terminal: { columns: 100, rows: 12 }, requestRender() {} } as never, theme as never, () => snapshot, () => {});
  let joined = "";
  for (let i = 0; i < 100; i++) { joined += component.render(68).join("\n"); component.handleInput("\x1b[6~"); }
  assert.match(joined, /\[truncated\]/); assert.doesNotMatch(joined, /OVER-BUDGET/);
});

test("real Pi TUI compositor routes resize-hidden keys to editor and restores editing after Esc", () => {
  const snapshot = fixture(), writes: string[] = [], editing: string[] = [];
  let input: (data: string) => void = () => {}, resize = () => {};
  const terminal = { columns: 100, rows: 12, kittyProtocolActive: false,
    start(onInput: typeof input, onResize: typeof resize) { input = onInput; resize = onResize; }, stop() {},
    write(data: string) { writes.push(data); }, drainInput: async () => {},
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = new TuiMainScreen(terminal);
  const editor = { render: () => ["EDITOR"], invalidate() {}, handleInput(data: string) { editing.push(data); } };
  tui.addChild(editor); tui.setFocus(editor); tui.start();
  const component = new ContextSidebarComponent(tui, theme as never, () => snapshot, () => { handle.setHidden(true); handle.unfocus(); }, { isFocused: () => handle.isFocused() });
  const handle = tui.showOverlay(component, readerContextOverlayOptions());
  try {
    for (const width of [100, 119, 120]) {
      terminal.columns = width; resize(); tui.renderNow(true);
      input("\x1b[F"); tui.renderNow(true);
      assert.equal(editing.length, 0);
      assert.ok(writes.join("").includes("TASK-2-TAIL"));
    }
    terminal.columns = 99; resize(); tui.renderNow(true); input("r"); input("\t");
    assert.deepEqual(editing, ["r", "\t"], "hidden overlay never captures retry/tab");
    terminal.columns = 100; resize(); tui.renderNow(true); handle.focus();
    input("\x1b"); input("typed-after-escape");
    assert.equal(editing.at(-1), "typed-after-escape");
    assert.equal(tui.getFocusedComponent(), editor);
  } finally { handle.hide(); tui.stop(); }
});
