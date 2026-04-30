import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { getPlatformHomeDir, getSkillsDir, getTeamsDir } from "../paths.js";

function withPathEnv(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-core-paths-"));
  const previous = {
    config: process.env["PA_PLATFORM_CONFIG"],
    home: process.env["PA_PLATFORM_HOME"],
    teams: process.env["PA_PLATFORM_TEAMS"],
    skills: process.env["PA_PLATFORM_SKILLS"],
  };

  delete process.env["PA_PLATFORM_HOME"];
  delete process.env["PA_PLATFORM_TEAMS"];
  delete process.env["PA_PLATFORM_SKILLS"];
  process.env["PA_PLATFORM_CONFIG"] = join(root, "config");
  mkdirSync(process.env["PA_PLATFORM_CONFIG"], { recursive: true });

  try {
    fn(root);
  } finally {
    restore("PA_PLATFORM_CONFIG", previous.config);
    restore("PA_PLATFORM_HOME", previous.home);
    restore("PA_PLATFORM_TEAMS", previous.teams);
    restore("PA_PLATFORM_SKILLS", previous.skills);
    rmSync(root, { recursive: true, force: true });
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("path helpers derive teams and skills from config_dir", () => {
  withPathEnv((root) => {
    const platform = join(root, "platform");
    writeFileSync(join(root, "config", "config.yaml"), `config_dir: ${platform}\n`);

    assert.equal(getPlatformHomeDir(), platform);
    assert.equal(getTeamsDir(), join(platform, "teams"));
    assert.equal(getSkillsDir(), join(platform, "skills", "global"));
  });
});

test("explicit teams_dir and skills_dir override config_dir defaults", () => {
  withPathEnv((root) => {
    const platform = join(root, "platform");
    const teams = join(root, "custom-teams");
    const skills = join(root, "custom-skills");
    writeFileSync(join(root, "config", "config.yaml"), [`config_dir: ${platform}`, `teams_dir: ${teams}`, `skills_dir: ${skills}`, ""].join("\n"));

    assert.equal(getPlatformHomeDir(), platform);
    assert.equal(getTeamsDir(), teams);
    assert.equal(getSkillsDir(), skills);
  });
});

test("loadConfig derives home, teams, and skills from the provided config file", () => {
  withPathEnv((root) => {
    const platform = join(root, "platform");
    const configPath = join(root, "config", "config.yaml");
    writeFileSync(configPath, `config_dir: ${platform}\n`);

    const config = loadConfig(configPath);
    assert.equal(config.homeDir, platform);
    assert.equal(config.teamsDir, join(platform, "teams"));
    assert.equal(config.skillsDir, join(platform, "skills", "global"));
  });
});
