import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const fail = (): never => { throw new Error("AXI_POLICY_REJECTED"); };
export interface BrowserRoutingOwner { dir: string; id: string; token: string; inode: number; device: number }
export interface BrowserRouting {
  selected: () => number | undefined;
  lost: () => boolean;
  select: (pageId: number) => void;
  clear: () => void;
}
const validId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
function state(owner: BrowserRoutingOwner): string {
  if (!/^d-[a-z0-9]+$/.test(owner.id) || !isAbsolute(owner.dir) || resolve(owner.dir) !== owner.dir || basename(owner.dir) !== owner.id) return fail();
  const path = join(owner.dir, "axi-browser");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.ino !== owner.inode || stat.dev !== owner.device || realpathSync(path) !== path) return fail();
  return path;
}
function readPrivateText(owner: BrowserRoutingOwner, path: string, limit: number): string | undefined {
  state(owner);
  let before;
  try { before = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (before.isSymbolicLink()) return fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > limit || stat.ino !== before.ino || stat.dev !== before.dev) return fail();
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== stat.size || length > limit || after.size !== stat.size || after.uid !== stat.uid || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.mode !== stat.mode || after.nlink !== stat.nlink) return fail();
    state(owner);
    return buffer.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}
function readSelection(owner: BrowserRoutingOwner): number | undefined {
  const text = readPrivateText(owner, join(state(owner), "routing.json"), 1024);
  if (text === undefined) return undefined;
  const value = JSON.parse(text) as { version?: unknown; token?: unknown; pageId?: unknown };
  // Canonical own-writer format rejects duplicate/extra keys and ambiguous
  // numeric encodings. Bind routing to this exact supervisor's nonce.
  if (!value || value.version !== 1 || value.token !== owner.token || !validId(value.pageId) || text !== JSON.stringify({ version: 1, token: owner.token, pageId: value.pageId })) return fail();
  return value.pageId;
}
/** Exact pinned AXI named-session path under OUR private HOME. The bridge
 * clears this numeric mirror on its one-shot MCP reconnect notice. The mirror
 * may invalidate our nonce-bound record, but can NEVER establish routing. */
function mirrorFile(owner: BrowserRoutingOwner, create = false): string | undefined {
  let path = state(owner);
  for (const component of ["home", ".chrome-devtools-axi", "sessions", owner.id]) {
    path = join(path, component);
    if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    // Upstream creates some descendants as 0755. They remain inaccessible
    // behind our 0700 HOME; never accept writable, foreign or symlink dirs.
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || (component === "home" && (stat.mode & 0o077) !== 0) || realpathSync(path) !== path) return fail();
  }
  state(owner);
  return join(path, "selected-page-id");
}
function readMirror(owner: BrowserRoutingOwner): number | undefined {
  const path = mirrorFile(owner);
  const text = path === undefined ? undefined : readPrivateText(owner, path, 16);
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!validId(value) || text !== String(value)) return fail();
  return value;
}
function atomicWrite(owner: BrowserRoutingOwner, path: string, text: string): void {
  const target = (): void => { if (path !== join(state(owner), "routing.json") && path !== mirrorFile(owner)) fail(); };
  target();
  const temporary = join(dirname(path), `routing-${randomUUID()}.tmp`);
  writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  target();
  renameSync(temporary, path);
}
/** Serialize routing-changing operations within one private browser deployment.
 * A concurrent/stale lock rejects; it never silently chooses another page.
 * Supervisor teardown removes the whole owned state (including stale locks).
 * Routing is separate from owner.json, which the supervisor updates frequently. */
export async function withBrowserRouting<T>(owner: BrowserRoutingOwner, action: (routing: BrowserRouting) => Promise<T>): Promise<T> {
  const directory = state(owner);
  const lock = join(directory, "routing-lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return fail(); throw error; }
  const identity = lstatSync(lock);
  let lost = false;
  const clear = (): void => {
    const selected = readSelection(owner);
    const mirror = readMirror(owner);
    if (selected !== undefined) unlinkSync(join(state(owner), "routing.json"));
    if (mirror !== undefined) { state(owner); unlinkSync(mirrorFile(owner)!); }
  };
  try {
    return await action({
      selected: () => {
        const selected = readSelection(owner);
        if (selected !== undefined && readMirror(owner) !== selected) { clear(); lost = true; return undefined; }
        return selected;
      },
      lost: () => lost,
      select: (pageId) => {
        if (!validId(pageId)) return fail();
        readSelection(owner); readMirror(owner); // Never overwrite malformed/foreign metadata.
        atomicWrite(owner, mirrorFile(owner, true)!, String(pageId));
        atomicWrite(owner, join(state(owner), "routing.json"), JSON.stringify({ version: 1, token: owner.token, pageId }));
        lost = false;
      },
      clear,
    });
  } finally {
    try {
      state(owner);
      const current = lstatSync(lock);
      if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid?.() || current.ino !== identity.ino || current.dev !== identity.dev) fail();
      rmdirSync(lock);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export interface BrowserToolRequest { name: string; args: Record<string, unknown> }
function explicitId(value: string | undefined): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value) || !validId(Number(value))) return fail();
  return Number(value);
}
/** Keep MCP's default explicit page-ID routing. The first open creates a page;
 * later page-scoped operations require our own selection, never list_pages text. */
export function browserToolRequest(args: readonly string[], selected: number | undefined, identityLost = false): BrowserToolRequest {
  const [command, a, b] = args;
  if (selected !== undefined && !validId(selected)) return fail();
  if (command === "pages") return { name: "list_pages", args: {} };
  if (command === "newpage") return { name: "new_page", args: { url: a } };
  if (command === "selectpage") return { name: "select_page", args: { pageId: explicitId(a) } };
  if (command === "closepage") return { name: "close_page", args: { pageId: explicitId(a) } };
  if (identityLost) return fail(); // This invocation may not silently reopen/retarget.
  if (command === "open" && selected === undefined) return { name: "new_page", args: { url: a } };
  if (selected === undefined) return fail();
  const calls: Record<string, BrowserToolRequest> = {
    snapshot: { name: "take_snapshot", args: {} },
    open: { name: "navigate_page", args: { type: "url", url: a } },
    click: { name: "click", args: { uid: a?.replace(/^@/, "") } },
    fill: { name: "fill", args: { uid: a?.replace(/^@/, ""), value: b } },
    press: { name: "press_key", args: { key: a } },
    back: { name: "navigate_page", args: { type: "back" } },
  };
  const call = calls[command!];
  if (!call) return fail();
  return { name: call.name, args: { ...call.args, pageId: selected } };
}
