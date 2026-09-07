import type { PiRuntime, PiToolDefinition } from "../../pi-extension/index.js";

export type HostMode = "tui" | "print" | "json";
export type HostHandler = (event: unknown, context: unknown) => unknown;
export type HostCommand = { description: string; handler: (args: string, context: unknown) => unknown };
export type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => ComposedEditor;

export interface ComposedEditor {
  getText(): string;
  setText(text: string): void;
  getCursor(): { line: number; col: number };
  getVimMode(): string;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate(): void;
}

class Container {
  readonly children: unknown[] = [];
  addChild(component: unknown): void { this.children.push(component); }
  render(): string[] { return []; }
  invalidate(): void {}
}

class FooterComponent {
  render(): string[] { return ["cwd", "0%/128k model"]; }
  invalidate(): void {}
}

export class FakeComposedUi {
  component: EditorFactory | undefined;
  readonly editorAssignments: Array<EditorFactory | undefined> = [];
  readonly statuses = new Map<string, string | undefined>();
  readonly notifications: Array<[string, string]> = [];
  readonly terminalInputHandlers = new Set<(data: string) => unknown>();
  customOpenCount = 0;
  toolsExpanded = false;
  editorText = "";
  readonly theme = {
    fg: (_color: string, text: string) => text,
    getFgAnsi: (_color: string) => "",
  };

  getEditorComponent = (): EditorFactory | undefined => this.component;
  setEditorComponent = (component: EditorFactory | undefined): void => {
    this.component = component;
    this.editorAssignments.push(component);
  };
  setStatus = (key: string, value: string | undefined): void => { this.statuses.set(key, value); };
  notify = (message: string, level: string): void => { this.notifications.push([message, level]); };
  onTerminalInput = (handler: (data: string) => unknown): (() => void) => {
    this.terminalInputHandlers.add(handler);
    return () => { this.terminalInputHandlers.delete(handler); };
  };
  addAutocompleteProvider = (): void => {};
  setEditorText = (text: string): void => { this.editorText = text; };
  getToolsExpanded = (): boolean => this.toolsExpanded;
  setToolsExpanded = (expanded: boolean): void => { this.toolsExpanded = expanded; };
  custom = async (): Promise<undefined> => { this.customOpenCount += 1; return undefined; };
}

export class FakeComposedTui {
  readonly terminalWrites: string[] = [];
  readonly inputListeners = new Set<(data: string) => unknown>();
  readonly footer = new FooterComponent();
  readonly chat = new Container();
  readonly children: unknown[];
  hardwareCursorVisible = false;
  renderRequests = 0;
  overlayCount = 0;
  readonly terminal = {
    rows: 24,
    columns: 100,
    write: (data: string): void => { this.terminalWrites.push(data); },
  };

  constructor() {
    const document = new Container();
    document.addChild(new Container());
    document.addChild(new Container());
    document.addChild(this.chat);
    this.children = [document, this.footer];
  }

  requestRender = (): void => { this.renderRequests += 1; };
  addInputListener = (listener: (data: string) => unknown): (() => void) => {
    this.inputListeners.add(listener);
    return () => { this.inputListeners.delete(listener); };
  };
  getShowHardwareCursor = (): boolean => this.hardwareCursorVisible;
  setShowHardwareCursor = (visible: boolean): void => { this.hardwareCursorVisible = visible; };
  showOverlay = (): { hide: () => void } => {
    this.overlayCount += 1;
    let visible = true;
    return { hide: () => { if (visible) this.overlayCount -= 1; visible = false; } };
  };
}

export class FakeKeybindings {
  private bindings: Record<string, string | string[]> = {};
  getKeys(id: string): string[] {
    const value = this.bindings[id];
    return value === undefined ? [] : Array.isArray(value) ? [...value] : [value];
  }
  getUserBindings(): Record<string, string | string[]> { return { ...this.bindings }; }
  setUserBindings(bindings: Record<string, string | string[]>): void { this.bindings = { ...bindings }; }
  reload(): void {}
  matches(): boolean { return false; }
  getDefinition(): { defaultKeys: string[] } { return { defaultKeys: [] }; }
  getConflicts(): string[] { return []; }
}

export interface FakeComposedContext {
  mode: HostMode;
  hasUI: boolean;
  cwd: string;
  ui: FakeComposedUi;
  sessionManager: {
    getBranch(): unknown[];
    getEntries(): unknown[];
    getEntry(id: string): undefined;
    getLeafId(): null;
    getSessionFile(): undefined;
  };
  model?: { provider: string; id: string };
  thinkingLevel: string;
  isIdle(): boolean;
  shutdown(): void;
  abort(): void;
}

export class FakeComposedHost {
  readonly handlers = new Map<string, HostHandler[]>();
  readonly commands = new Map<string, HostCommand>();
  readonly tools = new Map<string, PiToolDefinition>();
  readonly shortcuts: string[] = [];
  readonly markdownTransformers: Array<(markdown: string, context: { messageType: string; isStreaming: boolean }) => string> = [];
  readonly appendedEntries: Array<[string, unknown]> = [];
  readonly sentMessages: string[] = [];
  sessionName: string | undefined;
  selectedModel: unknown;

  readonly runtime: PiRuntime;

  constructor() {
    const runtime = {
      on: (event: string, handler: HostHandler): void => {
        const current = this.handlers.get(event) ?? [];
        current.push(handler);
        this.handlers.set(event, current);
      },
      registerCommand: (name: string, command: HostCommand): void => { this.commands.set(name, command); },
      registerShortcut: (shortcut: string): void => { this.shortcuts.push(shortcut); },
      registerTool: (tool: PiToolDefinition): void => { this.tools.set(tool.name, tool); },
      registerMarkdownTransformer: (transformer: (markdown: string, context: { messageType: string; isStreaming: boolean }) => string): void => { this.markdownTransformers.push(transformer); },
      getCommands: (): Array<{ name: string; source: "extension" }> => [...this.commands.keys()].map((name) => ({ name, source: "extension" as const })),
      getSessionName: (): string | undefined => this.sessionName,
      setSessionName: (name: string): void => { this.sessionName = name; },
      setModel: async (model: unknown): Promise<boolean> => { this.selectedModel = model; return true; },
      appendEntry: (type: string, data: unknown): void => { this.appendedEntries.push([type, data]); },
      sendUserMessage: (text: string): void => { this.sentMessages.push(text); },
    };
    this.runtime = runtime as unknown as PiRuntime;
  }

  async dispatch(event: string, value: unknown, context: unknown, limit?: number): Promise<unknown[]> {
    const results: unknown[] = [];
    const handlers = this.handlers.get(event) ?? [];
    for (const handler of limit === undefined ? handlers : handlers.slice(0, limit)) {
      results.push(await handler(value, context));
    }
    return results;
  }
}

export function createHostContext(mode: HostMode, cwd: string, ui = new FakeComposedUi()): FakeComposedContext {
  return {
    mode,
    hasUI: mode === "tui",
    cwd,
    ui,
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getEntry: (_id: string) => undefined,
      getLeafId: () => null,
      getSessionFile: () => undefined,
    },
    thinkingLevel: "medium",
    isIdle: () => true,
    shutdown: () => {},
    abort: () => {},
  };
}
