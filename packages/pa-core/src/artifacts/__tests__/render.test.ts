import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess, { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCoreCommand } from "../../cli/core-command.js";
import { ARTIFACT_DIAGNOSTICS, ARTIFACT_SOURCE_MAX_BYTES, ArtifactPolicyError, ARTIFACT_STYLE } from "../policy.js";
import { renderArtifact, renderMarkdown } from "../render.js";
import { artifactSha256, validateArtifactManifest } from "../manifest.js";

import { isolatedArtifactEnvironment as cleanEnvironment, renderEnvironment as safeEnv } from "./test-environment.js";
function fixture(t: { after(fn: () => void): void }): { root: string; source: string } {
  const root = mkdtempSync("/tmp/pa-render-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source.md");
  writeFileSync(source, "# Authoritative\n\nText.\n");
  return { root, source };
}
function rejects(fn: () => unknown, code: keyof typeof ARTIFACT_DIAGNOSTICS): void {
  assert.throws(fn, (error: unknown) => error instanceof ArtifactPolicyError
    && error.diagnostic === code && error.exitCode === ARTIFACT_DIAGNOSTICS[code].exitCode);
}
async function cli(args: string[], binaryName = "ppa"): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [], stderr: string[] = [];
  const code = await runCoreCommand(["artifact", ...args], { binaryName, io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) } });
  return { code, stdout, stderr };
}

test("repeat rendering is byte-identical, private, source-authoritative, and independent of output path", (t) => {
  const { root, source } = fixture(t);
  const original = readFileSync(source);
  const first = renderArtifact(source, join(root, "one"), safeEnv);
  const second = renderArtifact(source, join(root, "two"), safeEnv);
  assert.deepEqual(readdirSync(first.outputDir).sort(), ["index.html", "manifest.json"]);
  assert.equal(lstatSync(first.outputDir).mode & 0o777, 0o700);
  for (const name of ["index.html", "manifest.json"]) {
    const bytes = readFileSync(join(first.outputDir, name));
    assert.deepEqual(bytes, readFileSync(join(second.outputDir, name)));
    assert.equal(lstatSync(join(first.outputDir, name)).mode & 0o777, 0o600);
    assert.ok(!bytes.includes(Buffer.from(first.outputDir)));
    assert.ok(!bytes.includes(Buffer.from(second.outputDir)));
  }
  assert.equal(first.sourceSha256, artifactSha256(original));
  assert.deepEqual(readFileSync(source), original);
  assert.equal(validateArtifactManifest(first.manifest).identity.manifestSha256, first.manifestSha256);
  assert.deepEqual(readdirSync(root).sort(), ["one", "source.md", "two"]);
});

test("supported headings, nested lists, GFM tables, code and inert links have deterministic block anchors", () => {
  const markdown = "# Heading\n\n- first\n  - nested\n\n| A | B |\n| --- | --- |\n| x | y |\n\n```mermaid\ngraph TD; A-->B\n```\n\n[link](https://example.invalid)\n";
  const rendered = renderMarkdown(Buffer.from(markdown), "/source/document.md");
  const html = rendered.html.toString();
  for (const fragment of ["<h1>Heading</h1>", "<ul>", "<li>", "<table>", "<th>A</th>", "<td>x</td>", "<pre><code>graph TD; A--&gt;B</code></pre>", "[link](https://example.invalid)"]) assert.ok(html.includes(fragment), fragment);
  assert.deepEqual(rendered.anchors, [
    { id: "source-L1-L1", startLine: 1, endLine: 1 },
    { id: "source-L3-L4", startLine: 3, endLine: 4 },
    { id: "source-L6-L8", startLine: 6, endLine: 8 },
    { id: "source-L10-L12", startLine: 10, endLine: 12 },
    { id: "source-L14-L14", startLine: 14, endLine: 14 },
  ]);
  for (const anchor of rendered.anchors) assert.ok(html.includes(`id="${anchor.id}"`));
});

test("raw HTML and unsupported constructs cannot create active DOM, assets, forms or navigation", () => {
  const hostile = [
    '<script>globalThis.PWNED=1</script>', '<img src="https://example.invalid/leak" onerror="PWNED=1">',
    '<svg onload="PWNED=1"><foreignObject>bad</foreignObject></svg>',
    '<form action="https://example.invalid"><input name="secret"></form>',
    '<meta http-equiv="refresh" content="0;url=https://example.invalid">',
    '<style>@import "https://example.invalid/css";</style>',
    '[execute](javascript:alert(1)) ![remote](https://example.invalid/image)',
    '[file](file:///etc/passwd) [internal](#source-L1-L1)',
    '```html\n</code></pre><iframe src="https://example.invalid"></iframe>\n```',
    '> blockquote <b>raw</b>\n\n~~unsupported~~\n\n- [x] task',
    '[ref]: https://example.invalid\n[ref]: https://other.invalid\n\n[ref]',
  ].join("\n\n");
  const html = renderMarkdown(Buffer.from(hostile), "/source/a<&\".md").html.toString();
  assert.doesNotMatch(html, /<(?:script|img|svg|form|input|iframe|object|a|link|foreignObject)\b/i);
  assert.doesNotMatch(html, /<[^>]*\s(?:href|src|onload|onerror|action)=/i);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;/code&gt;&lt;/pre&gt;&lt;iframe"));
  assert.ok(html.includes("/source/a&lt;&amp;&quot;.md"));
  assert.ok(html.includes("Content-Security-Policy"));
  const styleHash = createHash("sha256").update(ARTIFACT_STYLE).digest("base64");
  assert.ok(html.includes(`style-src &#39;sha256-${styleHash}&#39;`));
  assert.ok(html.includes("default-src &#39;none&#39;"));
  assert.equal((html.match(/<style>/g) ?? []).length, 1);
  assert.ok(html.includes("Feedback is not approval."));
});

test("inclusive 2 MiB cap, strict UTF-8, empty source and CRLF/Unicode preserve raw source digests", (t) => {
  const { root, source } = fixture(t);
  const exact = Buffer.alloc(ARTIFACT_SOURCE_MAX_BYTES, 0x61);
  writeFileSync(source, exact);
  assert.equal(renderArtifact(source, join(root, "exact"), safeEnv).sourceSha256, artifactSha256(exact));
  writeFileSync(source, Buffer.alloc(ARTIFACT_SOURCE_MAX_BYTES + 1, 0x61));
  rejects(() => renderArtifact(source, join(root, "over"), safeEnv), "ARTIFACT_SOURCE_INVALID");
  assert.equal(existsSync(join(root, "over")), false);
  for (const bytes of [Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82]), Buffer.from([0xff])]) {
    writeFileSync(source, bytes);
    rejects(() => renderArtifact(source, join(root, "invalid"), safeEnv), "ARTIFACT_SOURCE_INVALID");
  }
  for (const [index, bytes] of [Buffer.alloc(0), Buffer.from("# 文档\r\n\r\nCafé 😀\r\n"), Buffer.from("\ufeff# BOM\n"), Buffer.from("# CR\r\rtext\r")].entries()) {
    writeFileSync(source, bytes);
    const rendered = renderArtifact(source, join(root, `unicode-${index}`), safeEnv);
    assert.equal(rendered.sourceSha256, artifactSha256(bytes));
    assert.deepEqual(readFileSync(source), bytes);
    validateArtifactManifest(rendered.manifest);
  }
  const crlf = renderMarkdown(Buffer.from("# 标题\r\n\r\nText\r\n"), source);
  const lf = renderMarkdown(Buffer.from("# 标题\n\nText\n"), source);
  assert.deepEqual(crlf, lf); // bytes differ, presentation/line numbers do not.
});

test("rejects existing destinations, source/output overlap, symlinks, hardlinks and nonregular sources without deletion", (t) => {
  const { root, source } = fixture(t);
  const prior = join(root, "prior");
  mkdirSync(prior);
  rejects(() => renderArtifact(source, prior, safeEnv), "ARTIFACT_OUTPUT_CONFLICT");
  assert.ok(lstatSync(prior).isDirectory());
  writeFileSync(join(prior, "sentinel"), "preserve");
  rejects(() => renderArtifact(source, prior, safeEnv), "ARTIFACT_OUTPUT_CONFLICT");
  rejects(() => renderArtifact(source, source, safeEnv), "ARTIFACT_OUTPUT_CONFLICT");
  rejects(() => renderArtifact(source, `${source}/child`, safeEnv), "ARTIFACT_OUTPUT_CONFLICT");
  rejects(() => renderArtifact(source, root, safeEnv), "ARTIFACT_OUTPUT_CONFLICT");
  symlinkSync(source, join(root, "source-link.md"));
  rejects(() => renderArtifact(join(root, "source-link.md"), join(root, "bad"), safeEnv), "ARTIFACT_SOURCE_INVALID");
  symlinkSync(prior, join(root, "dir-link"));
  rejects(() => renderArtifact(source, join(root, "dir-link/new"), safeEnv), "ARTIFACT_OUTPUT_CONFLICT");
  rejects(() => renderArtifact(source, join(root, "dir-link"), safeEnv), "ARTIFACT_OUTPUT_CONFLICT");
  rejects(() => renderArtifact(join(root, "dir-link/sentinel"), join(root, "bad"), safeEnv), "ARTIFACT_SOURCE_INVALID");
  symlinkSync(join(root, "absent"), join(root, "dangling"));
  // Existing broken links cannot be verified by the existing output safety gate.
  rejects(() => renderArtifact(source, join(root, "dangling"), safeEnv), "ARTIFACT_POLICY_REJECTED");
  rejects(() => renderArtifact(prior, join(root, "bad"), safeEnv), "ARTIFACT_SOURCE_INVALID");
  const fifo = join(root, "pipe.md");
  execFileSync("mkfifo", [fifo], { env: { PATH: process.env.PATH } });
  rejects(() => renderArtifact(fifo, join(root, "bad"), safeEnv), "ARTIFACT_SOURCE_INVALID");
  linkSync(source, join(root, "hard.md"));
  rejects(() => renderArtifact(source, join(root, "bad"), safeEnv), "ARTIFACT_SOURCE_INVALID");
  assert.equal(readFileSync(join(prior, "sentinel"), "utf8"), "preserve");
  assert.equal(readFileSync(source, "utf8"), "# Authoritative\n\nText.\n");
  assert.equal(readdirSync(root).some((name) => name.startsWith(".pa-artifact-")), false);
});

test("a destination created at the publication boundary is never replaced, including an empty directory", (t) => {
  const { root, source } = fixture(t);
  const output = join(root, "raced");
  const original = childProcess.spawnSync;
  let inode: number | undefined;
  const mock = t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof childProcess.spawnSync>) => {
    mkdirSync(output);
    inode = lstatSync(output).ino;
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  rejects(() => renderArtifact(source, output, safeEnv), "ARTIFACT_OUTPUT_CONFLICT");
  assert.equal(lstatSync(output).ino, inode);
  assert.deepEqual(readdirSync(output), []);
  assert.deepEqual(readdirSync(root).sort(), ["raced", "source.md"]);
});

test("a write failure removes only the unpublished own temporary entries", (t) => {
  const { root, source } = fixture(t);
  const output = join(root, "failed");
  const original = fs.writeFileSync;
  let calls = 0;
  const mock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (++calls === 2) throw new Error("secret-sentinel");
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  rejects(() => renderArtifact(source, output, safeEnv), "ARTIFACT_RUNTIME_FAILED");
  assert.deepEqual(readdirSync(root), ["source.md"]);
  assert.equal(readFileSync(source, "utf8"), "# Authoritative\n\nText.\n");
});

test("source changes before publication reject stale output and preserve the new authoritative bytes", (t) => {
  const { root, source } = fixture(t);
  const output = join(root, "stale");
  const original = fs.fsyncSync;
  let calls = 0;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    original(fd);
    if (++calls === 3) writeFileSync(source, "# Changed before publication\n");
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  rejects(() => renderArtifact(source, output, safeEnv), "ARTIFACT_STALE");
  assert.deepEqual(readdirSync(root), ["source.md"]);
  assert.equal(readFileSync(source, "utf8"), "# Changed before publication\n");
});

test("failure after publication preserves the complete output instead of deleting it", (t) => {
  const { root, source } = fixture(t);
  const output = join(root, "published");
  const original = fs.fsyncSync;
  let calls = 0;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (++calls === 4) throw new Error("secret-sentinel");
    return original(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  rejects(() => renderArtifact(source, output, safeEnv), "ARTIFACT_RUNTIME_FAILED");
  assert.deepEqual(readdirSync(output).sort(), ["index.html", "manifest.json"]);
  validateArtifactManifest(join(output, "manifest.json"));
  assert.deepEqual(readdirSync(root).sort(), ["published", "source.md"]);
});

test("policy adds no write roots or helper override and rejects unsafe inherited configuration before writes", (t) => {
  const { root, source } = fixture(t);
  const out = join(root, "never");
  rejects(() => renderArtifact(source, "/unauthorized/new-companion", safeEnv), "ARTIFACT_POLICY_REJECTED");
  rejects(() => renderArtifact("/tmp/.env", out, safeEnv), "ARTIFACT_POLICY_REJECTED");
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH", "LAVISH_AXI_HOST", "LAVISH_AXI_FUTURE"]) {
    rejects(() => renderArtifact(source, out, { ...safeEnv, [key]: "secret-sentinel" }), "ARTIFACT_POLICY_REJECTED");
  }
  rejects(() => renderArtifact(source, out, { PATH: root }), "ARTIFACT_RUNTIME_FAILED");
  for (const path of ["relative", "/a/../b", "/a//b", "/a/", "/a\0b"]) {
    rejects(() => renderArtifact(source, path, safeEnv), "ARTIFACT_USAGE_INVALID");
  }
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(root), ["source.md"]);
});

test("shared dispatcher uses the exact success envelope for ppa/opa/cpa, and errors never emit a success payload", async (t) => {
  const { root, source } = fixture(t);
  await cleanEnvironment(async () => {
    for (const binary of ["ppa", "opa", "cpa"]) {
      const out = join(root, binary);
      const result = await cli(["render", "--source", source, "--output-dir", out, "--json"], binary);
      assert.equal(result.code, 0);
      assert.deepEqual(result.stderr, []);
      assert.equal(result.stdout.length, 1);
      const value = JSON.parse(result.stdout[0]!) as {
        schema: string; operation: string; status: string; payload: { sourceRef: string; manifest: string };
      };
      assert.deepEqual(Object.keys(value), ["schema", "operation", "status", "payload"]);
      assert.equal(value.schema, "pa-artifact/v1");
      assert.equal(value.operation, "render");
      assert.equal(value.status, "rendered");
      assert.equal(value.payload.sourceRef, source);
      assert.equal(value.payload.manifest, `${out}/manifest.json`);
    }
    const base = ["render", "--source", source, "--output-dir", join(root, "rejected"), "--json"];
    for (const args of [[], ["unknown"], base.slice(0, -1), [...base, "--json"], [...base, "--source", "secret-sentinel"], [...base, "--host", "secret-sentinel"], [...base, "--share"], [...base, "--"], ["render", "--source=secret-sentinel", "--json"], ["--help", "--share"]]) {
      const result = await cli(args);
      assert.deepEqual(result.stdout, []);
      assert.equal(result.code, 2);
      assert.deepEqual(result.stderr, ["ARTIFACT_USAGE_INVALID: Invalid artifact arguments."]);
    }
    assert.equal(existsSync(join(root, "rejected")), false);
    process.env.LAVISH_AXI_HOST = "secret-sentinel";
    try {
      const result = await cli(base);
      assert.equal(result.code, 5);
      assert.deepEqual(result.stdout, []);
      assert.deepEqual(result.stderr, ["ARTIFACT_POLICY_REJECTED: Artifact policy rejected the operation."]);
    } finally { delete process.env.LAVISH_AXI_HOST; }
    const conflict = await cli(["render", "--source", source, "--output-dir", join(root, "ppa"), "--json"]);
    assert.equal(conflict.code, 8);
    assert.deepEqual(conflict.stdout, []);
    assert.deepEqual(conflict.stderr, ["ARTIFACT_OUTPUT_CONFLICT: Artifact output conflict."]);
  });
});

test("review metadata describes implemented ownership/prerequisites and invalid sessions fail closed", async () => {
  await cleanEnvironment(async () => {
    for (const binary of ["ppa", "opa", "cpa"]) {
      for (const args of [["--help"], ["render", "--help"], ["review", "--help"], ["review", "start", "--help"]]) {
        const result = await cli(args, binary);
        assert.equal(result.code, 0);
        assert.match(result.stdout.join(""), /requires selected managed Lavish and a live deployment owner/);
        assert.match(result.stdout.join(""), /matching adapter\/deployment\/process owner/);
        assert.doesNotMatch(result.stdout.join(""), /lifecycle is unavailable/);
        assert.match(result.stdout.join(""), /no browser or selected Lavish required/);
      }
      for (const [args, expected] of [
        [["review", "start", "--manifest", "/tmp/never/manifest.json", "--json"], 3],
        [["review", "status", "--session", "opaque-session", "--json"], 2],
        [["review", "stop", "--session", "opaque-session", "--json"], 2],
        [["review", "feedback", "--session", "opaque-session", "--output", "/tmp/never.json", "--json"], 2],
        [["review", "status", "--session", "a".repeat(48), "--json"], 6],
        [["review", "stop", "--session", "a".repeat(48), "--json"], 6],
        [["review", "feedback", "--session", "a".repeat(48), "--output", "/tmp/never.json", "--json"], 6],
        [["review", "feedback", "--session", "a".repeat(48), "--output", "/tmp/never.json", "--timeout-ms", "30001", "--json"], 2],
        [["review", "stop", "--session", "../../secret-sentinel", "--json"], 2],
        [["review", "start", "--manifest", "/tmp/never/manifest.json", "--json", "--open"], 2],
      ] as const) {
        const result = await cli([...args], binary);
        assert.equal(result.code, expected);
        assert.deepEqual(result.stdout, []);
        assert.equal(result.stderr.length, 1);
        assert.doesNotMatch(result.stderr[0]!, /secret-sentinel|\/tmp/);
      }
    }
  });
});

test("completion source advertises only bounded v1 flags and isolates overlapping status/review namespaces", () => {
  const source = readFileSync(new URL("../../../../../completions/pa-core.fish", import.meta.url), "utf8");
  const artifact = source.split("\n").filter((line) => line.startsWith("complete ") && /artifact/.test(line));
  for (const flag of ["source", "output-dir", "manifest", "session", "output", "timeout-ms", "json", "help"]) {
    assert.ok(artifact.some((line) => line.includes(`-l ${flag} `)), flag);
  }
  assert.ok(artifact.some((line) => line.includes("start status stop feedback")));
  assert.equal(artifact.some((line) => /-l (host|port|share|open|force)\b/.test(line)), false);
  for (const line of source.split("\n").filter((line) => line.includes("-l running") || line.includes("-l activity"))) {
    assert.ok(line.includes("not __fish_seen_subcommand_from artifact"));
  }
  const generator = readFileSync(new URL("../../../../../scripts/dev/generate_completions.sh", import.meta.url), "utf8");
  for (const line of generator.split("\n").filter((line) => line.includes("__fish_seen_subcommand_from review;"))) {
    assert.ok(line.includes("not __fish_seen_subcommand_from artifact"));
  }
});
