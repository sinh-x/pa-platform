import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { getConfigDir, getDataDir, getPlatformHomeDir, getSkillsDir, getTeamsDir, getUserConfigPath } from "./paths.js";
import type { PlatformConfig, ProviderDefaults } from "./types.js";

interface RawConfig {
  config_dir?: string;
  data_dir?: string;
  teams_dir?: string;
  skills_dir?: string;
  defaults?: PlatformConfig["defaults"];
  provider_defaults?: ProviderDefaults;
}

export function loadConfig(configPath = getUserConfigPath()): PlatformConfig {
  const raw = existsSync(configPath)
    ? (yaml.load(readFileSync(configPath, "utf-8")) as RawConfig | undefined) ?? {}
    : {};

  return {
    configDir: process.env["PA_PLATFORM_CONFIG"] ?? raw.config_dir ?? getConfigDir(),
    dataDir: process.env["PA_PLATFORM_DATA"] ?? raw.data_dir ?? getDataDir(),
    homeDir: process.env["PA_PLATFORM_HOME"] ?? getPlatformHomeDir(),
    teamsDir: process.env["PA_PLATFORM_TEAMS"] ?? raw.teams_dir ?? getTeamsDir(),
    skillsDir: process.env["PA_PLATFORM_SKILLS"] ?? raw.skills_dir ?? getSkillsDir(),
    provider_defaults: raw.provider_defaults,
    defaults: raw.defaults,
  };
}
