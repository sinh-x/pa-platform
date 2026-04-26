import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getBulletinsDir } from "../paths.js";
import { parseBulletin, serializeBulletin } from "./types.js";
import type { Bulletin, BulletinBlock } from "./types.js";

// Ported from PA bulletins/store.ts at frozen PA source on 2026-04-26; locking is delegated to adapter/CLI call sites for now.

export class BulletinStore {
  private readonly activeDir: string;
  private readonly resolvedDir: string;
  private readonly counterPath: string;

  constructor(baseDir = getBulletinsDir()) {
    this.activeDir = resolve(baseDir, "active");
    this.resolvedDir = resolve(baseDir, "resolved");
    this.counterPath = resolve(baseDir, "counter.json");
    mkdirSync(this.activeDir, { recursive: true });
    mkdirSync(this.resolvedDir, { recursive: true });
  }

  readActive(): Bulletin[] {
    if (!existsSync(this.activeDir)) return [];
    return readdirSync(this.activeDir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => parseBulletin(readFileSync(resolve(this.activeDir, file), "utf-8"), file))
      .filter((bulletin): bulletin is Bulletin => !!bulletin);
  }

  create(opts: { title: string; block: BulletinBlock; except?: string[]; body: string }): Bulletin {
    const id = this.allocateId();
    const created = new Date().toISOString();
    const filename = `${created.slice(0, 10)}-${slugify(opts.title)}.md`;
    const bulletin = {
      id,
      title: opts.title,
      status: "active" as const,
      block: opts.block,
      except: opts.except ?? [],
      created,
      body: opts.body,
    };
    writeFileSync(resolve(this.activeDir, filename), serializeBulletin(bulletin));
    return { ...bulletin, filename };
  }

  resolve(id: string): boolean {
    for (const file of existsSync(this.activeDir) ? readdirSync(this.activeDir).filter((name) => name.endsWith(".md")) : []) {
      const source = resolve(this.activeDir, file);
      const bulletin = parseBulletin(readFileSync(source, "utf-8"), file);
      if (bulletin?.id !== id) continue;
      writeFileSync(source, serializeBulletin({ ...bulletin, status: "resolved" }));
      renameSync(source, resolve(this.resolvedDir, file));
      return true;
    }
    return false;
  }

  private allocateId(): string {
    const counter = existsSync(this.counterPath) ? (JSON.parse(readFileSync(this.counterPath, "utf-8")) as { next?: number }) : {};
    const next = counter.next ?? 1;
    writeFileSync(this.counterPath, JSON.stringify({ next: next + 1 }, null, 2));
    return `B-${String(next).padStart(3, "0")}`;
  }
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "bulletin";
}
