import assert from "node:assert/strict";
import test from "node:test";
import { ConfigScriptDependencies, ConfigScriptDependencyError } from "../deploy/config-script-dependencies.js";

function source(files: Record<string, string>) {
  return new ConfigScriptDependencies(path => files[path] ?? null);
}

test("script dependency discovery parses imports, const-array file URLs and root-owned data without evaluating code", () => {
  const files = {
    "scripts/check.mjs": 'import { paths as templates } from "./data.mjs"; import { readFileSync } from "node:fs"; const input=process.argv[2]; readFileSync(input); readFileSync(new URL(`../${templates[0]}`,import.meta.url)); throw new Error("must never evaluate");',
    "scripts/data.mjs": 'export const paths=["docs/template.html", "docs/other.html"];',
  };
  const reader = source(files);
  assert.deepEqual(new Set(reader.references("scripts/check.mjs", files["scripts/check.mjs"])), new Set(["scripts/data.mjs", "docs/template.html"]));
  assert.deepEqual(new Set(reader.references("scripts/data.mjs", files["scripts/data.mjs"])), new Set(["docs/template.html", "docs/other.html"]));
});

test("script graph rejects unresolved selectors, execution loaders and paths outside config ownership", () => {
  for (const script of [
    "import(process.argv[2]);", "require(process.argv[2]);", "const loader=require; loader('./missing.js');",
    "import value from '/foreign/source.mjs';", "import value from 'unretained-package';",
    "new URL(`../${process.argv[2]}`, import.meta.url);", 'new URL("../../foreign.md", import.meta.url);',
    'import { readFileSync } from "node:fs"; readFileSync(process.env.PA_PLATFORM_HOME);',
    'import { readdirSync } from "node:fs"; readdirSync("./support");',
    'import { spawn } from "node:child_process";', 'import { createRequire } from "node:module";',
    'eval("require(dynamic)");', 'new Function("require(dynamic)");',
    'const fs=require("node:fs"); fs.readFileSync(process.env.PA_PLATFORM_HOME);',
    'import { readFileSync } from "node:fs"; const load=readFileSync; load(dynamic);',
    'import fs from "node:fs"; const load=fs.readFileSync; load(dynamic);',
  ]) assert.throws(() => source({}).references("scripts/check.mjs", script), ConfigScriptDependencyError, script);
});

test("comments, regular expressions and quoted code examples do not become JavaScript imports", () => {
  const body = '// import("./missing.mjs")\nconst example="import(unknown)"; const expression=/import\\(.*/; export { item } from "./library.mjs";';
  assert.deepEqual(source({}).references("scripts/check.mjs", body), ["scripts/library.mjs"]);
});

test("static selector addition preserves numeric JavaScript semantics rather than retaining a different file", () => {
  const body = 'const one=1; new URL(`../docs/value-${one+one}.md`,import.meta.url); new URL("../docs/value-"+("2"+3)+".md",import.meta.url);';
  assert.deepEqual(new Set(source({}).references("scripts/check.mjs", body)), new Set(["docs/value-2.md", "docs/value-23.md"]));
});

test("constant expansion has a shared work budget and bounds strings before concatenation", () => {
  const repeated = ['const v0="x";', ...Array.from({ length: 11 }, (_, index) => `const v${index+1}=v${index}+v${index};`)].join("\n");
  const bodies = [
    `${repeated}\nnew URL("../docs/"+v11+".md",import.meta.url);`,
    `new URL("../docs/"+"${"x".repeat(4096)}"+".md",import.meta.url);`,
    `new URL(\`../docs/${"x".repeat(4096)}\u0024{1}.md\`,import.meta.url);`,
    'new URL(`../docs/value-${1e309}.md`,import.meta.url);',
  ];
  for (const body of bodies) {
    const reader = source({});
    assert.throws(() => reader.references("scripts/check.mjs", body), ConfigScriptDependencyError);
    assert.deepEqual(reader.references("scripts/next.mjs", 'new URL("../docs/next.md",import.meta.url);'), ["docs/next.md"], "work budget resets per captured script");
  }
});

test("constant cycles and malformed code reject within finite parsing bounds", () => {
  for (const body of ['const item=item; new URL(item,import.meta.url);', 'const item = ;', 'const paths=[]; new URL(paths[9],import.meta.url);'])
    assert.throws(() => source({}).references("scripts/check.mjs", body), ConfigScriptDependencyError);
});
