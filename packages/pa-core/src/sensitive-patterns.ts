import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import yaml from "js-yaml";
import { getConfigDir } from "./paths.js";

export type SensitiveInputClass = "filename" | "path" | "content";
export type SensitivePatternSource = "built-in" | "local-config";

export interface SensitivePattern {
  inputClass: SensitiveInputClass;
  source: SensitivePatternSource;
  regex: RegExp;
}

export interface SensitivePatternSet {
  configPath: string;
  patterns: SensitivePattern[];
}

export interface SensitivePatternMatch {
  inputClass: SensitiveInputClass;
  source: SensitivePatternSource;
  configPath: string;
}

interface RawSensitivePatternConfig {
  filenames?: unknown;
  filename_patterns?: unknown;
  paths?: unknown;
  path_patterns?: unknown;
  contents?: unknown;
  content_patterns?: unknown;
}

export class SensitiveInputBlockedError extends Error {
  readonly inputClass: SensitiveInputClass;
  readonly source: SensitivePatternSource;
  readonly configPath: string;

  constructor(match: SensitivePatternMatch) {
    const sourceLabel = match.source === "local-config" ? "local sensitive pattern config" : "built-in sensitive defaults";
    super(`Blocked sensitive ${match.inputClass} input by ${sourceLabel}.`);
    this.name = "SensitiveInputBlockedError";
    this.inputClass = match.inputClass;
    this.source = match.source;
    this.configPath = match.configPath;
  }
}

export function getSensitivePatternsConfigPath(configDir = getConfigDir()): string {
  return resolve(configDir, "sensitive-patterns.yaml");
}

export function loadSensitivePatterns(configPath = getSensitivePatternsConfigPath()): SensitivePatternSet {
  const patterns = [...createBuiltInSensitivePatterns()];
  if (!existsSync(configPath)) return { configPath, patterns };

  const raw = loadRawSensitivePatternConfig(configPath);
  patterns.push(...createLocalSensitivePatterns(raw, configPath));
  return { configPath, patterns };
}

export function findSensitiveMatch(inputClass: SensitiveInputClass, value: string, patternSet = loadSensitivePatterns()): SensitivePatternMatch | undefined {
  for (const pattern of patternSet.patterns) {
    if (pattern.inputClass === inputClass && pattern.regex.test(value)) {
      return { inputClass, source: pattern.source, configPath: patternSet.configPath };
    }
  }
  return undefined;
}

export function assertNoSensitiveMatch(inputClass: SensitiveInputClass, value: string, patternSet = loadSensitivePatterns()): void {
  const match = findSensitiveMatch(inputClass, value, patternSet);
  if (match) throw new SensitiveInputBlockedError(match);
}

export function readGuardedLocalTextFile(filePath: string, patternSet = loadSensitivePatterns()): string {
  const resolvedPath = resolve(filePath);
  assertNoSensitiveMatch("path", resolvedPath, patternSet);
  assertNoSensitiveMatch("filename", getSensitiveFilename(resolvedPath), patternSet);

  const content = readFileSync(resolvedPath, "utf-8");
  assertNoSensitiveMatch("content", content, patternSet);
  return content;
}

function createBuiltInSensitivePatterns(): SensitivePattern[] {
  return [
    filename(/^\.env(?:\..*)?$/i),
    filename(/^\.npmrc$/i),
    filename(/^\.pypirc$/i),
    filename(/^\.netrc$/i),
    filename(/^credentials.*\.json$/i),
    filename(/^secret.*\.json$/i),
    filename(/^secrets.*\.ya?ml$/i),
    filename(/^.*token.*\.json$/i),
    filename(/^.*api-key.*\.json$/i),
    filename(/^.*api_key.*\.json$/i),
    pathPattern(/(?:^|[/\\])\.ssh[/\\]id[^/\\]*$/i),
    content(/-----BEGIN [A-Z ]*PRIVATE KEY-----/),
    content(/\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*['\"]?[^\s'\"]{16,}/i),
  ];
}

function loadRawSensitivePatternConfig(configPath: string): RawSensitivePatternConfig {
  try {
    const loaded = yaml.load(readFileSync(configPath, "utf-8"));
    if (loaded === undefined || loaded === null) return {};
    if (!isRecord(loaded)) throw new Error("invalid-config-shape");
    return loaded as RawSensitivePatternConfig;
  } catch {
    throw new Error(`Failed to load sensitive pattern config from ${configPath}.`);
  }
}

function createLocalSensitivePatterns(raw: RawSensitivePatternConfig, configPath: string): SensitivePattern[] {
  return [
    ...compileLocalPatterns("filename", [...readStringArray(raw.filenames), ...readStringArray(raw.filename_patterns)], configPath),
    ...compileLocalPatterns("path", [...readStringArray(raw.paths), ...readStringArray(raw.path_patterns)], configPath),
    ...compileLocalPatterns("content", [...readStringArray(raw.contents), ...readStringArray(raw.content_patterns)], configPath),
  ];
}

function compileLocalPatterns(inputClass: SensitiveInputClass, values: string[], configPath: string): SensitivePattern[] {
  return values.map((value) => {
    try {
      return { inputClass, source: "local-config", regex: new RegExp(value, "i") };
    } catch {
      throw new Error(`Invalid sensitive ${inputClass} pattern in local config at ${configPath}.`);
    }
  });
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function filename(regex: RegExp): SensitivePattern {
  return { inputClass: "filename", source: "built-in", regex };
}

function pathPattern(regex: RegExp): SensitivePattern {
  return { inputClass: "path", source: "built-in", regex };
}

function content(regex: RegExp): SensitivePattern {
  return { inputClass: "content", source: "built-in", regex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getSensitiveFilename(value: string): string {
  return basename(value);
}
