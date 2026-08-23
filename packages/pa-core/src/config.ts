import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { expandHome, getConfigDir, getDataDir, getPlatformHomeDir, getSkillsDir, getTeamsDir, getUserConfigPath } from "./paths.js";
import type { PlatformConfig, ProviderDefaults, RepoConfig } from "./types.js";

interface RawConfig {
  config_dir?: string;
  data_dir?: string;
  teams_dir?: string;
  skills_dir?: string;
  defaults?: PlatformConfig["defaults"];
  provider_defaults?: ProviderDefaults;
  repos?: Record<string, RepoConfig>;
}

function mergeProviderDefaults(base: ProviderDefaults | undefined, override: ProviderDefaults | undefined): ProviderDefaults | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  return {
    default_provider: override.default_provider ?? base.default_provider,
    default_model: override.default_model ?? base.default_model,
    providers: { ...base.providers, ...override.providers },
  };
}

export function loadConfig(configPath = getUserConfigPath()): PlatformConfig {
  const raw = existsSync(configPath)
    ? (yaml.load(readFileSync(configPath, "utf-8")) as RawConfig | undefined) ?? {}
    : {};

  const homeDir = process.env["PA_PLATFORM_HOME"] ? expandHome(process.env["PA_PLATFORM_HOME"]) : raw.config_dir ? expandHome(raw.config_dir) : getPlatformHomeDir();
  const teamsDir = process.env["PA_PLATFORM_TEAMS"] ? expandHome(process.env["PA_PLATFORM_TEAMS"]) : raw.teams_dir ? expandHome(raw.teams_dir) : raw.config_dir ? resolve(homeDir, "teams") : getTeamsDir();
  const skillsDir = process.env["PA_PLATFORM_SKILLS"] ? expandHome(process.env["PA_PLATFORM_SKILLS"]) : raw.skills_dir ? expandHome(raw.skills_dir) : raw.config_dir ? resolve(homeDir, "skills/global") : getSkillsDir();

  // Merge provider_defaults from the external config repo (config_dir) if present,
  // so that provider credentials (e.g. factory api_key) stored in the external repo
  // flow through to all adapters. The main config overrides the external config.
  let externalProviderDefaults: ProviderDefaults | undefined;
  let externalRepos: Record<string, RepoConfig> | undefined;
  if (raw.config_dir) {
    const externalConfigPath = resolve(homeDir, "config.yaml");
    if (existsSync(externalConfigPath)) {
      const externalRaw = yaml.load(readFileSync(externalConfigPath, "utf-8")) as RawConfig | undefined;
      externalProviderDefaults = externalRaw?.provider_defaults;
      externalRepos = externalRaw?.repos;
    }
  }

  return {
    configDir: process.env["PA_PLATFORM_CONFIG"] ?? getConfigDir(),
    dataDir: process.env["PA_PLATFORM_DATA"] ?? raw.data_dir ?? getDataDir(),
    homeDir,
    teamsDir,
    skillsDir,
    repos: Object.fromEntries(Object.entries({ ...externalRepos, ...raw.repos }).map(([key, repo]) => [key, { ...repo, path: expandHome(repo.path) }])),
    provider_defaults: mergeProviderDefaults(externalProviderDefaults, raw.provider_defaults),
    defaults: raw.defaults,
  };
}
