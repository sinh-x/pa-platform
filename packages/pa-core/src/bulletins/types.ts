import yaml from "js-yaml";

export type BulletinBlock = "all" | string[];

export interface Bulletin {
  id: string;
  title: string;
  status: "active" | "resolved";
  block: BulletinBlock;
  except: string[];
  created: string;
  body: string;
  filename: string;
}

interface BulletinFrontmatter {
  id: string;
  title: string;
  status: "active" | "resolved";
  block: BulletinBlock;
  except?: string[];
  created: string;
}

// Ported from PA bulletins/types.ts at frozen PA source on 2026-04-26; pa-platform owns future changes.

export function parseBulletin(content: string, filename: string): Bulletin | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return undefined;
  try {
    const frontmatter = yaml.load(match[1]) as BulletinFrontmatter;
    if (!frontmatter.id || !frontmatter.title || !frontmatter.status || frontmatter.block === undefined) return undefined;
    return {
      id: String(frontmatter.id),
      title: frontmatter.title,
      status: frontmatter.status,
      block: frontmatter.block,
      except: frontmatter.except ?? [],
      created: String(frontmatter.created),
      body: match[2].trim(),
      filename,
    };
  } catch {
    return undefined;
  }
}

export function serializeBulletin(bulletin: Omit<Bulletin, "filename">): string {
  const frontmatter: BulletinFrontmatter = {
    id: bulletin.id,
    title: bulletin.title,
    status: bulletin.status,
    block: bulletin.block,
    created: bulletin.created,
  };
  if (bulletin.except.length > 0) frontmatter.except = bulletin.except;
  return `---\n${yaml.dump(frontmatter, { lineWidth: -1 }).trim()}\n---\n\n${bulletin.body}\n`;
}
