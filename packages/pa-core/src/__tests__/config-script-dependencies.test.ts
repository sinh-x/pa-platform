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
  const body = '// import("./missing.mjs")\nconst example="import(unknown)"; const expression=/import\\(.*/; import { item } from "./library.mjs";';
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

test("file URLs resolve against their module, not config locators; CWD filesystem strings reject", () => {
  assert.deepEqual(source({}).references("scripts/check.mjs", 'new URL("docs/data.md",import.meta.url);'), ["scripts/docs/data.md"]);
  for (const target of ["./docs/data.md", "docs/data.md", "/docs/data.md"]) {
    assert.throws(() => source({}).references("scripts/check.mjs", `import {readFileSync} from "node:fs"; readFileSync(${JSON.stringify(target)});`), ConfigScriptDependencyError);
  }
});

test("shadowed, mutated and escaped selectors reject rather than capture stale initializers", () => {
  for (const body of [
    'const item="../docs/first.md"; function read(){const item="../docs/second.md";new URL(item,import.meta.url);}',
    'const item="../docs/first.md"; function read(item){new URL(item,import.meta.url);}',
    'const paths=["../docs/first.md"]; paths[0]="../docs/second.md";new URL(paths[0],import.meta.url);',
    'const paths=["../docs/first.md"];for(paths[0] of ["../docs/second.md"]){}new URL(paths[0],import.meta.url);',
    'const paths=["../docs/first.md"];for(paths[0] in {second:1}){}new URL(paths[0],import.meta.url);',
    'const paths=["../docs/first.md"];const alias=paths;alias[0]="../docs/second.md";new URL(paths[0],import.meta.url);',
    'const paths=["../docs/first.md"];paths.push("../docs/second.md");new URL(paths[0],import.meta.url);',
    'const paths=["../docs/first.md"];mutate(paths);new URL(paths[0],import.meta.url);',
    'const paths=["../docs/first.md"];const holder={paths};new URL(paths[0],import.meta.url);',
    'const URL=OtherURL;new URL("../docs/first.md",import.meta.url);',
    'import {readFileSync} from "node:fs";function read(process){readFileSync(process.argv[2]);}',
    'import {readFileSync} from "node:fs";process.argv[2]="docs/other.md";readFileSync(process.argv[2]);',
    'import {readFileSync} from "node:fs";process.argv.push("docs/other.md");readFileSync(process.argv[2]);',
    'const paths=["../docs/first.md","../docs/second.md"];paths["reverse"]();new URL(paths[0],import.meta.url);',
    'const paths=["../docs/first.md","../docs/second.md"];const method="reverse";paths[method]();new URL(paths[0],import.meta.url);',
  ]) assert.throws(() => source({}).references("scripts/check.mjs", body), ConfigScriptDependencyError, body);
  const files = {"scripts/data.mjs": 'export const paths=["../docs/first.md"];paths.reverse();'};
  assert.throws(() => source(files).references("scripts/check.mjs", 'import {paths} from "./data.mjs";new URL(paths[0],import.meta.url);'), ConfigScriptDependencyError);
});

test("all importers of a selector array must preserve its original contents regardless of traversal order", () => {
  for (const mutation of ['paths[0]="../docs/second.md";', 'mutate(paths);']) for (const first of [true, false]) {
    const files = {
      "scripts/data.mjs": 'export const paths=["../docs/first.md"];',
      "scripts/check.mjs": 'import {paths} from "./data.mjs";new URL(paths[0],import.meta.url);',
      "scripts/mutate.mjs": `import {paths} from "./data.mjs";${mutation}`,
    };
    const reader = source(files);
    assert.throws(() => {
      for (const file of first ? ["scripts/check.mjs", "scripts/mutate.mjs"] : ["scripts/mutate.mjs", "scripts/check.mjs"])
        reader.references(file, files[file as keyof typeof files]);
    }, ConfigScriptDependencyError);
  }
});

test("filesystem re-exports and dynamic imports cannot hide unqualified filesystem selectors", () => {
  for (const body of ['export {readFileSync} from "node:fs";', 'export * from "fs/promises";',
    'const {readFileSync}=await import("node:fs");readFileSync("docs/"+"second.md");',
    'const fs=await import("node:fs/promises");await fs.readFile(process.env.CONFIG);'])
    assert.throws(() => source({}).references("scripts/io.mjs", body), ConfigScriptDependencyError);
});

test("finite immutable dictionary keys are supported without enabling reflection or selector-array methods", () => {
  const body = 'const keys=["summary","outcome"];export function inspect(data){for(const key of keys){assert.ok(data[key]);}}';
  assert.deepEqual(source({}).references("scripts/check.mjs", body), []);
  for (const bad of [
    'for(const key of ["constructor"]){getObject()[key](process.env.CODE);}',
    'for(const key of ["summary"]){const key="constructor";getObject()[key]();}',
    'for(const key of ["summary"]){class key{static toString(){return "constructor";}}(()=>{})[key]("return 349")();}',
    'for(const key of ["summary"]){function key(){return "constructor";}getObject()[key]();}',
    'for(const key of ["require"]){module[key]("node:fs").readFileSync(process.env.CONFIG);}',
    'const paths=["../docs/first.md","../docs/second.md"];for(const method of ["reverse"]){paths[method]();}new URL(paths[0],import.meta.url);',
  ]) assert.throws(() => source({}).references("scripts/check.mjs", bad), ConfigScriptDependencyError);
});

test("opaque loaders and module-sharing edges reject instead of hiding retained dependencies", () => {
  for (const body of [
    'process.getBuiltinModule("fs").readFileSync(process.env.CONFIG);',
    'const builtin=process.getBuiltinModule;builtin("child_process").execSync(process.env.COMMAND);',
    'import {getBuiltinModule as builtin} from "node:process";builtin("fs").readFileSync(process.env.CONFIG);',
    'const {getBuiltinModule:builtin}=process;builtin("module").createRequire(import.meta.url);',
    'const paths=["../docs/first.md"];import * as data from "./data.mjs";data.paths[0]="../docs/second.md";new URL(paths[0],import.meta.url);',
    'import data from "./data.mjs";data.paths[0]="../docs/second.md";',
    'const data=await import("./data.mjs");data.paths[0]="../docs/second.md";',
    'const data=require("./data.mjs");data.paths[0]="../docs/second.md";',
    'export {paths as renamed} from "./data.mjs";',
    'export const paths=["../docs/first.md"];export {paths as hidden};',
    'export * from "./data.mjs";',
    'const ctor=(()=>{})["con"+"structor"];ctor(process.env.CODE)();',
    'const {"constructor":build}=(()=>{});const fs=await build(\'return import("node:fs")\')();fs.readFileSync("docs/"+"hidden.md");',
    'const {["con"+"structor"]:build}=(()=>{});build(process.env.CODE)();',
    'export const template=new (URL)("../docs/"+"hidden.md",import.meta.url);',
    'import {URL as FileURL} from "node:url";export const template=new FileURL("../docs/"+"hidden.md",import.meta.url);',
    'const Alias=URL;export const template=new Alias("../docs/hidden.md",import.meta.url);',
  ]) assert.throws(() => source({}).references("scripts/check.mjs", body), ConfigScriptDependencyError, body);
});

test("constant cycles and malformed code reject within finite parsing bounds", () => {
  for (const body of ['const item=item; new URL(item,import.meta.url);', 'const item = ;', 'const paths=[]; new URL(paths[9],import.meta.url);'])
    assert.throws(() => source({}).references("scripts/check.mjs", body), ConfigScriptDependencyError);
});
