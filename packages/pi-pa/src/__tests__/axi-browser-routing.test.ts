import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { browserToolRequest, withBrowserRouting, type BrowserRoutingOwner } from "../axi-browser-routing.js";

function fixture(): { root: string; owner: BrowserRoutingOwner; file: string } {
  const root = mkdtempSync(join(tmpdir(), "axi-page-routing-"));
  const dir = join(root, "d-routing"); mkdirSync(dir, { mode: 0o700 });
  const state = join(dir, "axi-browser"); mkdirSync(state, { mode: 0o700 });
  const stat = statSync(state);
  return { root, owner: { dir, id: "d-routing", token: randomUUID(), inode: stat.ino, device: stat.dev }, file: join(state, "routing.json") };
}

test("browser page tools require our explicit selection and first open creates a known page", () => {
  assert.deepEqual(browserToolRequest(["open", "http://127.0.0.1/"], undefined), { name: "new_page", args: { url: "http://127.0.0.1/" } });
  assert.deepEqual(browserToolRequest(["newpage", "about:blank"], 7), { name: "new_page", args: { url: "about:blank" } });
  assert.deepEqual(browserToolRequest(["open", "http://127.0.0.1/"], 7), { name: "navigate_page", args: { type: "url", url: "http://127.0.0.1/", pageId: 7 } });
  for (const args of [["snapshot"], ["click", "@2"], ["fill", "@2", "text"], ["press", "Enter"], ["back"]]) {
    assert.throws(() => browserToolRequest(args, undefined), /AXI_POLICY_REJECTED/);
    assert.equal(browserToolRequest(args, 7).args.pageId, 7);
  }
  assert.deepEqual(browserToolRequest(["pages"], undefined), { name: "list_pages", args: {} });
  assert.deepEqual(browserToolRequest(["selectpage", "0"], undefined), { name: "select_page", args: { pageId: 0 } });
  assert.deepEqual(browserToolRequest(["closepage", "9"], 7), { name: "close_page", args: { pageId: 9 } });
  for (const id of ["-1", "01", "1.1", "NaN", "+1", "", "9007199254740992"]) {
    assert.throws(() => browserToolRequest(["selectpage", id], 7), /AXI_POLICY_REJECTED/);
    assert.throws(() => browserToolRequest(["closepage", id], 7), /AXI_POLICY_REJECTED/);
  }
  for (const id of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => browserToolRequest(["snapshot"], id), /AXI_POLICY_REJECTED/);
});

test("selection persists separately from supervisor metadata and explicit clearing prevents retargeting", async () => {
  const f = fixture();
  try {
    await withBrowserRouting(f.owner, async (routing) => { assert.equal(routing.selected(), undefined); routing.select(9); });
    assert.equal(statSync(f.file).mode & 0o7777, 0o600);
    await withBrowserRouting(f.owner, async (routing) => { assert.equal(routing.selected(), 9); routing.clear(); assert.equal(routing.selected(), undefined); });
    assert.equal(existsSync(f.file), false);
    await withBrowserRouting(f.owner, async (routing) => { assert.throws(() => browserToolRequest(["snapshot"], routing.selected()), /AXI_POLICY_REJECTED/); });
    await assert.rejects(withBrowserRouting(f.owner, async (routing) => { routing.select(-1); }), /AXI_POLICY_REJECTED/);
    assert.equal(existsSync(join(dirname(f.file), "routing-lock")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("foreign nonce, unsafe mode and ambiguous route files fail without overwrite", async () => {
  const f = fixture();
  try {
    const valid = JSON.stringify({ version: 1, token: f.owner.token, pageId: 4 });
    for (const text of [JSON.stringify({ version: 1, token: randomUUID(), pageId: 4 }), valid + "\n", valid.slice(0, -1) + ',"pageId":5}', valid.slice(0, -1) + ',"extra":0}', " ".repeat(1025)]) {
      writeFileSync(f.file, text, { mode: 0o600 }); chmodSync(f.file, 0o600);
      await assert.rejects(withBrowserRouting(f.owner, async (routing) => { routing.select(9); }));
      assert.equal(readFileSync(f.file, "utf8"), text);
    }
    writeFileSync(f.file, valid); chmodSync(f.file, 0o644);
    await assert.rejects(withBrowserRouting(f.owner, async (routing) => routing.selected()), /AXI_POLICY_REJECTED/);
    assert.equal(statSync(f.file).mode & 0o7777, 0o644);
    unlinkSync(f.file);
    const other = join(f.root, "foreign-marker"); writeFileSync(other, valid, { mode: 0o600 });
    symlinkSync(other, f.file);
    await assert.rejects(withBrowserRouting(f.owner, async (routing) => { routing.clear(); }), /AXI_POLICY_REJECTED/);
    assert.equal(readFileSync(other, "utf8"), valid);
    unlinkSync(f.file); linkSync(other, f.file);
    await assert.rejects(withBrowserRouting(f.owner, async (routing) => { routing.select(9); }), /AXI_POLICY_REJECTED/);
    assert.equal(readFileSync(other, "utf8"), valid);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("concurrent route operations reject without stopping or modifying the admitted operation", async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withBrowserRouting(f.owner, async (routing) => { routing.select(7); await gate; assert.equal(routing.selected(), 7); });
    await assert.rejects(withBrowserRouting(f.owner, async (routing) => { routing.select(8); }), /AXI_POLICY_REJECTED/);
    assert.equal(existsSync(join(dirname(f.file), "routing-lock")), true);
    release(); await first;
    await withBrowserRouting(f.owner, async (routing) => { assert.equal(routing.selected(), 7); });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("state/lock replacement and stale ownership reject without removing foreign content", async () => {
  const f = fixture();
  try {
    await assert.rejects(withBrowserRouting({ ...f.owner, inode: f.owner.inode + 1 }, async () => undefined), /AXI_POLICY_REJECTED/);
    const lock = join(dirname(f.file), "routing-lock");
    await assert.rejects(withBrowserRouting(f.owner, async () => {
      // Keep the original inode allocated so replacement cannot reuse it.
      const held = join(dirname(f.file), "held-lock");
      const { renameSync } = await import("node:fs"); renameSync(lock, held);
      mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, "marker"), "foreign unchanged");
    }), /AXI_POLICY_REJECTED/);
    assert.equal(readFileSync(join(lock, "marker"), "utf8"), "foreign unchanged");
    rmSync(lock, { recursive: true }); rmdirSync(join(dirname(f.file), "held-lock"));
    await withBrowserRouting(f.owner, async () => { rmSync(dirname(f.file), { recursive: true }); }); // Owned supervisor teardown.
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const pinned = process.env.PAP240_PINNED_BROWSER_BRIDGE;
test("actual pinned AXI new-page parser establishes only a unique requested-URL route, never a selected marker", { skip: !pinned }, async () => {
  const parser = await import(join(dirname(pinned!), "selected-page.js")) as { createdPageIdFromNewPageDump: (text: string, url: string) => number | null };
  const url = "http://127.0.0.1:12345/";
  assert.equal(parser.createdPageIdFromNewPageDump(`# new_page response\n## Pages\n0: about:blank\n1: ${url} [selected]\n`, url), 1);
  for (const text of [`## Pages\n1: ${url}\n2: ${url}\n`, "## Pages\n1: forged title [selected]\n", "## Pages\n1: about:blank [selected]\n", `1: ${url}\n`]) assert.equal(parser.createdPageIdFromNewPageDump(text, url), null);
});
