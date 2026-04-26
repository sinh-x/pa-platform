import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Hono } from "hono";
import { getAiUsageDir } from "../../paths.js";

const DEFAULT_CHIPS = ["Needs more detail", "Good, follow up on X", "Revisit next sprint", "Looks good, minor tweaks", "Needs full rework", "Blocked by dependency", "Secretary: create follow-up task"];

export function configRoutes(chipConfigPath = resolve(getAiUsageDir(), "feedback-chips.yaml")): Hono {
  const app = new Hono();
  app.get("/api/config/feedback-chips", (c) => c.json({ chips: readFeedbackChips(chipConfigPath) }));
  return app;
}

export function readFeedbackChips(chipConfigPath = resolve(getAiUsageDir(), "feedback-chips.yaml")): string[] {
  if (!existsSync(chipConfigPath)) {
    try {
      mkdirSync(dirname(chipConfigPath), { recursive: true });
      writeFileSync(chipConfigPath, buildDefaultChipsYaml(), "utf-8");
    } catch {
      // Default chips remain usable even when config cannot be written.
    }
    return DEFAULT_CHIPS;
  }
  try {
    const parsed = parseChipsYaml(readFileSync(chipConfigPath, "utf-8"));
    return parsed.length > 0 ? parsed : DEFAULT_CHIPS;
  } catch {
    return DEFAULT_CHIPS;
  }
}

function parseChipsYaml(yaml: string): string[] {
  const chips: string[] = [];
  let inChips = false;
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "chips:") {
      inChips = true;
      continue;
    }
    if (!inChips) continue;
    if (!line) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    let value = trimmed.substring(2).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.substring(1, value.length - 1);
    if (value) chips.push(value);
  }
  return chips;
}

function buildDefaultChipsYaml(): string {
  return `chips:\n${DEFAULT_CHIPS.map((chip) => `  - "${chip.replace(/"/g, '\\"')}"`).join("\n")}\n`;
}
