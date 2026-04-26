import type { ParsedSignalNote } from "./types.js";

export function parseSignalNoteMarkdown(content: string): ParsedSignalNote {
  const lines = content.split("\n");
  const frontmatter: Record<string, string> = {};
  const bodyLines: string[] = [];
  let inFrontmatter = false;
  let bodyStarted = false;

  for (const line of lines) {
    if (line.trim() === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      }
      inFrontmatter = false;
      bodyStarted = true;
      continue;
    }
    if (bodyStarted) bodyLines.push(line);
    else if (inFrontmatter) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) frontmatter[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
    }
  }

  return { frontmatter, body: bodyLines.join("\n").trim() };
}

export function parseJsonArrayFrontmatter(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
