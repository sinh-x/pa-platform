import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ContentInputOptions {
  cwd?: string;
}

export function resolveContentInput(inline: string | undefined, file: string | undefined, label: string, options: ContentInputOptions = {}): string | undefined {
  if (inline !== undefined && file !== undefined) throw new Error(`--${label} and --${label}-file are mutually exclusive; pass exactly one.`);
  if (file === undefined) return inline;
  const path = resolve(options.cwd ?? process.cwd(), file);
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read --${label}-file ${path}: ${message}`, { cause: error });
  }
}
