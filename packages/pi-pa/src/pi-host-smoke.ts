import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendRegistryEvent, closeDb, verifyRegistryNativeAddon } from "@pa-platform/pa-core";
import { createBashTool, createReadTool } from "@earendil-works/pi-coding-agent";
import registerPiPaExtension, { createPaTools } from "./pi-extension/index.js";
import { createQuestionTool } from "./pi-extension/question.js";
import { createTodoTool, TodoStore } from "./pi-extension/todo.js";

const MANAGED_TOOLS = ["read", "bash", "question", "todo", "pa_ticket", "pa_bulletin", "pa_registry", "pa_status"] as const;

type ManagedToolName = (typeof MANAGED_TOOLS)[number];
interface ToolSmokeResult { name: ManagedToolName; status: "passed" }

export async function runHostNativeSmoke(addonPath: string): Promise<ReturnType<typeof verifyRegistryNativeAddon>> {
  return verifyRegistryNativeAddon(addonPath);
}

export async function runHostManagedToolSmoke(addonPath: string): Promise<{ node: string; modules: string; tools: ToolSmokeResult[] }> {
  const root = mkdtempSync(join(tmpdir(), "pap-156-tools-"));
  const previous = {
    aiUsage: process.env["PA_AI_USAGE_HOME"],
    registry: process.env["PA_REGISTRY_DB"],
    binding: process.env["PA_SQLITE_NATIVE_BINDING"],
  };
  process.env["PA_AI_USAGE_HOME"] = root;
  process.env["PA_REGISTRY_DB"] = join(root, "deployments", "registry.db");
  process.env["PA_SQLITE_NATIVE_BINDING"] = addonPath;

  try {
    const fixtureText = "pap-156 managed read fixture\n";
    const fixturePath = join(root, "fixture.txt");
    writeFileSync(fixturePath, fixtureText);
    seedTicketFixture(root);
    appendRegistryEvent({
      deployment_id: "d-pap156",
      team: "builder",
      event: "started",
      timestamp: "2026-08-29T00:00:00.000Z",
      mode: "implement",
      runtime: "pi",
      binary: "ppa",
    });

    const registered: string[] = [];
    registerPiPaExtension({ registerTool: (tool) => registered.push(tool.name) });
    const expectedRegistered = ["pa_ticket", "pa_bulletin", "pa_registry", "pa_status", "question", "todo"];
    assertEqual(registered, expectedRegistered, "registered PA tools");

    const read = createReadTool(root);
    const readResult = await read.execute("pap156-read", { path: fixturePath });
    assertIncludes(toolText(readResult), "pap-156 managed read fixture", "read result");

    const bash = createBashTool(root);
    const bashResult = await bash.execute("pap156-bash", { command: "printf pap-156-managed-bash" });
    assertIncludes(toolText(bashResult), "pap-156-managed-bash", "bash result");

    const questionResult = await createQuestionTool().execute(
      "pap156-question",
      { question: "Select fixture", options: [{ label: "fixture" }] },
      undefined,
      undefined,
      { mode: "print" },
    );
    assertIncludes(toolText(questionResult), "Question unavailable in print mode", "question result");

    const todoResult = await createTodoTool(new TodoStore()).execute(
      "pap156-todo",
      { action: "add", text: "fixture task" },
      undefined,
      undefined,
      undefined,
    );
    assertIncludes(toolText(todoResult), "Task added", "todo result");

    const paTools = new Map(createPaTools().map((tool) => [tool.name, tool]));
    const paInputs: Array<[string, Record<string, unknown>, string]> = [
      ["pa_ticket", { action: "show", id: "PAP-900" }, "PAP-900"],
      ["pa_bulletin", { action: "list" }, "[]"],
      ["pa_registry", { action: "show", id: "d-pap156" }, "d-pap156"],
      ["pa_status", { id: "d-pap156" }, "d-pap156"],
    ];
    for (const [name, input, expected] of paInputs) {
      const tool = paTools.get(name);
      if (!tool) throw new Error(`managed tool smoke did not register ${name}`);
      const result = await tool.execute(`pap156-${name}`, input, undefined, undefined, undefined);
      assertIncludes(toolText(result), expected, `${name} result`);
    }

    return {
      node: process.version,
      modules: process.versions.modules ?? "unknown",
      tools: MANAGED_TOOLS.map((name) => ({ name, status: "passed" as const })),
    };
  } finally {
    closeDb();
    restoreEnv("PA_AI_USAGE_HOME", previous.aiUsage);
    restoreEnv("PA_REGISTRY_DB", previous.registry);
    restoreEnv("PA_SQLITE_NATIVE_BINDING", previous.binding);
    rmSync(root, { recursive: true, force: true });
  }
}

function seedTicketFixture(root: string): void {
  const tickets = join(root, "tickets");
  mkdirSync(tickets, { recursive: true });
  writeFileSync(join(tickets, "PAP-900.json"), JSON.stringify({
    id: "PAP-900",
    project: "pa-platform",
    title: "PAP-156 bounded tool fixture",
    summary: "Synthetic package smoke fixture",
    status: "implementing",
    priority: "low",
    type: "task",
    assignee: "builder/team-manager",
    estimate: "XS",
    tags: ["fixture"],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  }, null, 2));
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

function assertIncludes(actual: string, expected: string, label: string): void {
  if (!actual.includes(expected)) throw new Error(`${label} did not contain expected fixture evidence`);
}

function assertEqual(actual: string[], expected: string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} mismatch: ${JSON.stringify(actual)}`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const addonPath = process.argv[3];
  if (!addonPath || (mode !== "native" && mode !== "tools")) throw new Error("native-load: expected native|tools and an addon path");
  const result = mode === "native" ? await runHostNativeSmoke(addonPath) : await runHostManagedToolSmoke(addonPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
