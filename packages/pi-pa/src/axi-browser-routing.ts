import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const fail = (): never => { throw new Error("AXI_POLICY_REJECTED"); };
export interface BrowserRoutingOwner { dir: string; id: string; token: string; inode: number; device: number }
export interface BrowserRouting {
  selected: () => number | undefined;
  select: (pageId: number) => void;
  clear: () => void;
}
const validId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id >= 0;
function state(owner: BrowserRoutingOwner): string {
  const path = join(owner.dir, "axi-browser");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.ino !== owner.inode || stat.dev !== owner.device || realpathSync(path) !== path) return fail();
  return path;
}
function readSelection(owner: BrowserRoutingOwner): number | undefined {
  const path = join(state(owner), "routing.json");
  let before;
  try { before = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (before.isSymbolicLink()) return fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > 1024 || stat.ino !== before.ino || stat.dev !== before.dev) return fail();
    const buffer = Buffer.alloc(1025);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== stat.size || length > 1024 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.mode !== stat.mode || after.nlink !== stat.nlink) return fail();
    state(owner);
    const text = buffer.subarray(0, length).toString("utf8");
    const value = JSON.parse(text) as { version?: unknown; token?: unknown; pageId?: unknown };
    // Canonical own-writer format rejects duplicate/extra keys and ambiguous
    // numeric encodings. Bind routing to this exact supervisor's nonce.
    if (!value || value.version !== 1 || value.token !== owner.token || !validId(value.pageId) || text !== JSON.stringify({ version: 1, token: owner.token, pageId: value.pageId })) return fail();
    return value.pageId;
  } finally { closeSync(fd); }
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
  try {
    return await action({
      selected: () => readSelection(owner),
      select: (pageId) => {
        if (!validId(pageId)) return fail();
        readSelection(owner); // Never overwrite a malformed/foreign routing file.
        const current = state(owner);
        const temporary = join(current, `routing-${randomUUID()}.tmp`);
        writeFileSync(temporary, JSON.stringify({ version: 1, token: owner.token, pageId }), { mode: 0o600, flag: "wx" });
        state(owner);
        renameSync(temporary, join(current, "routing.json"));
      },
      clear: () => {
        if (readSelection(owner) !== undefined) {
          const current = state(owner);
          unlinkSync(join(current, "routing.json"));
        }
      },
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
export function browserToolRequest(args: readonly string[], selected: number | undefined): BrowserToolRequest {
  const [command, a, b] = args;
  if (selected !== undefined && !validId(selected)) return fail();
  if (command === "pages") return { name: "list_pages", args: {} };
  if (command === "newpage" || (command === "open" && selected === undefined)) return { name: "new_page", args: { url: a } };
  if (command === "selectpage") return { name: "select_page", args: { pageId: explicitId(a) } };
  if (command === "closepage") return { name: "close_page", args: { pageId: explicitId(a) } };
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
