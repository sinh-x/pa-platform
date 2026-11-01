import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowDigest } from "../deploy/prepared-workflow.js";
import { MAX_PROJECT_COMMAND_CATALOGUE_BYTES, parseProjectCommandCatalogue, ProjectCatalogueError, selectCatalogueTaskChecks } from "../project-command-catalogue.js";

const repository = { key: "example", root: "/tmp/catalogue-repository" };
const command = (id = "unit") => ({ id, executable: "/nix/store/nonexistent-fixture/bin/node", argv: ["test.cjs", id], environment: { CI: "true" },
  readPaths: ["data/input.json"], prerequisites: [{ path: "test.cjs", sha256: "a".repeat(64) }], timeoutSeconds: 60, maximumOutputBytes: 4096 });
const fixture = () => ({ schemaVersion: "project-command-catalogue/v1", repository: { ...repository }, effects: ["project-read", "isolated-temp-write"], commands: [command(), command("lint")] });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const parse = (value: unknown) => parseProjectCommandCatalogue(bytes(value), repository);
function rejects(run: () => unknown, code?: string) {
  assert.throws(run, error => error instanceof ProjectCatalogueError && (!code || error.code === code) && !error.message.includes("PRIVATE-SENTINEL"));
}

test("catalogue is static immutable data with an exact raw-byte identity, not executable or approval evidence", () => {
  const raw = bytes(fixture()), catalogue = parseProjectCommandCatalogue(raw, repository);
  assert.equal(catalogue.sha256, workflowDigest(raw));
  assert.equal(catalogue.commands[0]!.command, "node 'test.cjs' 'unit'");
  // The executable deliberately does not exist. Parsing cannot probe or run it.
  assert.equal(catalogue.commands[0]!.executable, "/nix/store/nonexistent-fixture/bin/node");
  for (const value of [catalogue, catalogue.repository, catalogue.commands, catalogue.effects, catalogue.commands[0], catalogue.commands[0]!.argv,
    catalogue.commands[0]!.environment, catalogue.commands[0]!.readPaths, catalogue.commands[0]!.prerequisites, catalogue.commands[0]!.prerequisites[0]]) assert.ok(Object.isFrozen(value));
  const digest = catalogue.sha256; raw.fill(0); assert.equal(catalogue.sha256, digest);
  assert.deepEqual(Object.keys(catalogue).sort(), ["commands", "effects", "repository", "schemaVersion", "sha256"]);
});

test("catalogue semantics require every exact task check but not every catalogue member", () => {
  const catalogue = parse(fixture()), [unit, lint] = catalogue.commands;
  assert.deepEqual(selectCatalogueTaskChecks(catalogue, [unit!.command]), [unit]);
  assert.deepEqual(selectCatalogueTaskChecks(catalogue, [lint!.command, unit!.command]), [lint, unit]);
  assert.ok(Object.isFrozen(selectCatalogueTaskChecks(catalogue, [unit!.command])));
  for (const value of [[], ["unit"], [unit!.command, unit!.command], [unit!.command, "node 'outside.cjs'"], [unit!.command + " "], Array(65).fill(unit!.command)]) {
    rejects(() => selectCatalogueTaskChecks(catalogue, value), "CATALOGUE_TASK_CHECKS");
  }
  rejects(() => selectCatalogueTaskChecks({ ...catalogue }, [unit!.command]), "CATALOGUE_TASK_CHECKS");
});

test("raw formatting remains identity-significant and legacy contract/v1 is not reinterpreted", () => {
  const value = fixture();
  assert.notEqual(parseProjectCommandCatalogue(bytes(value), repository).sha256, parseProjectCommandCatalogue(Buffer.from(JSON.stringify(value, null, 2)), repository).sha256);
  rejects(() => parse({ schemaVersion: "project-command-contract/v1", effects: value.effects, checks: value.commands }));
});

test("catalogue byte parser rejects duplicate/escaped keys, trailing input, malformed UTF-8, excessive nesting and size", () => {
  const raw = JSON.stringify(fixture());
  for (const invalid of [raw.replace('"schemaVersion":', '"schemaVersion":"PRIVATE-SENTINEL","schemaVersion":'),
    raw.replace('"schemaVersion":', '"schemaVersion":"PRIVATE-SENTINEL","\\u0073chemaVersion":'),
    raw.replace('"CI":"true"', '"CI":"true","\\u0043I":"PRIVATE-SENTINEL"'), raw + " {}", "{", '[]',
    '{"nested":' + '['.repeat(70) + '0' + ']'.repeat(70) + '}']) {
    rejects(() => parseProjectCommandCatalogue(Buffer.from(invalid), repository), "CATALOGUE_JSON");
  }
  rejects(() => parseProjectCommandCatalogue(Buffer.from([0xff, 0xfe]), repository), "CATALOGUE_JSON");
  rejects(() => parseProjectCommandCatalogue(Buffer.alloc(MAX_PROJECT_COMMAND_CATALOGUE_BYTES + 1), repository), "CATALOGUE_SIZE");
  rejects(() => parseProjectCommandCatalogue(Buffer.alloc(0), repository), "CATALOGUE_SIZE");
});

const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["unknown version", f => { f.schemaVersion = "project-command-catalogue/v2"; }],
  ["caller authority", f => { Object.assign(f, { approved: true }); }],
  ["foreign repo key", f => { f.repository.key = "elsewhere"; }],
  ["foreign physical root", f => { f.repository.root = "/tmp/elsewhere"; }],
  ["noncanonical root", f => { f.repository.root += "/../alias"; }],
  ["extra repo fields", f => { Object.assign(f.repository, { grant: true }); }],
  ["extra effects", f => { f.effects.push("host-write"); }],
  ["reordered effects", f => { f.effects.reverse(); }],
  ["empty catalogue", f => { f.commands = []; }],
  ["oversized inventory", f => { f.commands = Array.from({ length: 65 }, (_, i) => command(`check-${i}`)); }],
  ["duplicate command id", f => { f.commands[1]!.id = "unit"; }],
  ["ambiguous command spelling", f => { f.commands[1]!.argv = [...f.commands[0]!.argv]; }],
  ["bad command id", f => { f.commands[0]!.id = "../escape"; }],
  ["extra command field", f => { Object.assign(f.commands[0]!, { shell: true }); }],
  ["relative executable", f => { f.commands[0]!.executable = "node"; }],
  ["ambiguous executable basename", f => { f.commands[0]!.executable = "/nix/store/fixture/bin/PRIVATE-SENTINEL binary"; }],
  ["unsupported executable root", f => { f.commands[0]!.executable = "/tmp/bin/node"; }],
  ["executable traversal", f => { f.commands[0]!.executable = "/nix/store/bin/../node"; }],
  ["argv control", f => { f.commands[0]!.argv.push("\nPRIVATE-SENTINEL"); }],
  ["argv bound", f => { f.commands[0]!.argv = Array(129).fill("arg"); }],
  ["loader injection", f => { Object.assign(f.commands[0]!.environment, { NODE_OPTIONS: "--require PRIVATE-SENTINEL" }); }],
  ["runtime injection", f => { Object.assign(f.commands[0]!.environment, { PA_ROGUE_ONE: "1" }); }],
  ["credential environment", f => { Object.assign(f.commands[0]!.environment, { API_TOKEN: "PRIVATE-SENTINEL" }); }],
  ["ambient PATH", f => { Object.assign(f.commands[0]!.environment, { PATH: "/tmp" }); }],
  ["input traversal", f => { f.commands[0]!.readPaths.push("../outside"); }],
  ["Git metadata input", f => { f.commands[0]!.readPaths.push(".git/config"); }],
  ["administrative input", f => { f.commands[0]!.readPaths.push(".pa/project-commands.json"); }],
  ["secret input", f => { f.commands[0]!.readPaths.push(".env"); }],
  ["duplicate inputs", f => { f.commands[0]!.readPaths.push("data/input.json"); }],
  ["missing prerequisites", f => { f.commands[0]!.prerequisites = []; }],
  ["invalid prerequisite digest", f => { f.commands[0]!.prerequisites[0]!.sha256 = "A".repeat(64); }],
  ["duplicate prerequisites", f => { f.commands[0]!.prerequisites.push({ ...f.commands[0]!.prerequisites[0]! }); }],
  ["excessive timeout", f => { f.commands[0]!.timeoutSeconds = 1801; }],
  ["fractional timeout", f => { f.commands[0]!.timeoutSeconds = 1.5; }],
  ["empty output bound", f => { f.commands[0]!.maximumOutputBytes = 0; }],
  ["excessive output bound", f => { f.commands[0]!.maximumOutputBytes = 16 * 1024 * 1024 + 1; }],
];
for (const [name, mutate] of mutations) test(`catalogue rejects ${name} without leaking inputs`, () => {
  const value = fixture(); mutate(value); rejects(() => parse(value));
});

test("catalogue argv values remain exact inert literals including shell metacharacters and quotes", () => {
  const value = fixture(); value.commands[0]!.argv = ["test.cjs", "a'b", "$(PRIVATE-SENTINEL)", ""];
  const catalogue = parse(value);
  assert.deepEqual(catalogue.commands[0]!.argv, value.commands[0]!.argv);
  assert.equal(catalogue.commands[0]!.command, "node 'test.cjs' 'a'\\''b' '$(PRIVATE-SENTINEL)' ''");
});
