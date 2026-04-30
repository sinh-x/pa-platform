import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { expandHome, getConfigDir, getDataDir, getPlatformHomeDir, getSkillsDir, getTeamsDir, getUserConfigPath } from "./paths.js";
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

  const homeDir = process.env["PA_PLATFORM_HOME"] ? expandHome(process.env["PA_PLATFORM_HOME"]) : raw.config_dir ? expandHome(raw.config_dir) : getPlatformHomeDir();
  const teamsDir = process.env["PA_PLATFORM_TEAMS"] ? expandHome(process.env["PA_PLATFORM_TEAMS"]) : raw.teams_dir ? expandHome(raw.teams_dir) : raw.config_dir ? resolve(homeDir, "teams") : getTeamsDir();
  const skillsDir = process.env["PA_PLATFORM_SKILLS"] ? expandHome(process.env["PA_PLATFORM_SKILLS"]) : raw.skills_dir ? expandHome(raw.skills_dir) : raw.config_dir ? resolve(homeDir, "skills/global") : getSkillsDir();

  return {
    configDir: process.env["PA_PLATFORM_CONFIG"] ?? getConfigDir(),
    dataDir: process.env["PA_PLATFORM_DATA"] ?? raw.data_dir ?? getDataDir(),
    homeDir,
    teamsDir,
    skillsDir,
    provider_defaults: raw.provider_defaults,
    defaults: raw.defaults,
  };
}
