import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertNoSensitiveMatch, findSensitiveMatch, getSensitivePatternsConfigPath, loadSensitivePatterns, SensitiveInputBlockedError } from "../sensitive-patterns.js";

function withConfigDir(fn: (configDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pa-core-sensitive-patterns-"));
  const previousConfig = process.env["PA_PLATFORM_CONFIG"];
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  process.env["PA_PLATFORM_CONFIG"] = configDir;

  try {
    fn(configDir);
  } finally {
    if (previousConfig === undefined) delete process.env["PA_PLATFORM_CONFIG"];
    else process.env["PA_PLATFORM_CONFIG"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
}

test("loads built-in defaults when local sensitive pattern config is missing", () => {
  withConfigDir((configDir) => {
    const patternSet = loadSensitivePatterns();

    assert.equal(patternSet.configPath, join(configDir, "sensitive-patterns.yaml"));
    for (const name of [".env", ".npmrc", ".pypirc", ".netrc", "credentials.json", "credentials-prod.json", "secret.json", "secrets.yaml", "secrets.yml", "service-token.json", "service-api-key.json", "service-api_key.json"]) {
      assert.equal(findSensitiveMatch("filename", name, patternSet)?.source, "built-in", name);
    }
    assert.equal(findSensitiveMatch("path", "/repo/.ssh/id_ed25519", patternSet)?.source, "built-in");
  });
});

test("loads fake local filename, path, and content patterns", () => {
  withConfigDir((configDir) => {
    writeFileSync(getSensitivePatternsConfigPath(), ["filenames:", "  - '^fake-sensitive-name\\.txt$'", "paths:", "  - 'fake-sensitive-dir'", "contents:", "  - 'FAKE_LOCAL_MARKER_[0-9]+'", ""].join("\n"));

    const patternSet = loadSensitivePatterns();

    assert.equal(findSensitiveMatch("filename", "fake-sensitive-name.txt", patternSet)?.source, "local-config");
    assert.equal(findSensitiveMatch("path", join(configDir, "fake-sensitive-dir", "note.md"), patternSet)?.source, "local-config");
    assert.equal(findSensitiveMatch("content", "contains FAKE_LOCAL_MARKER_123 only", patternSet)?.source, "local-config");
  });
});

test("sensitive match errors do not include regex strings or matched content", () => {
  withConfigDir(() => {
    writeFileSync(getSensitivePatternsConfigPath(), ["contents:", "  - 'FAKE_PRIVATE_REGEX_[0-9]+'", ""].join("\n"));
    const patternSet = loadSensitivePatterns();

    assert.throws(
      () => assertNoSensitiveMatch("content", "contains FAKE_PRIVATE_REGEX_123", patternSet),
      (error: unknown) => {
        assert.equal(error instanceof SensitiveInputBlockedError, true);
        assert.equal((error as Error).message.includes("FAKE_PRIVATE_REGEX"), false);
        assert.equal((error as Error).message.includes("123"), false);
        assert.match((error as Error).message, /Blocked sensitive content input/);
        assert.match((error as Error).message, /local sensitive pattern config/);
        return true;
      },
    );
  });
});

test("local config load and compile errors are sanitized", () => {
  withConfigDir(() => {
    writeFileSync(getSensitivePatternsConfigPath(), ["contents:", "  - 'FAKE_BAD_PATTERN_['", ""].join("\n"));

    assert.throws(
      () => loadSensitivePatterns(),
      (error: unknown) => {
        assert.equal((error as Error).message.includes("FAKE_BAD_PATTERN"), false);
        assert.match((error as Error).message, /Invalid sensitive content pattern in local config/);
        return true;
      },
    );
  });
});

test("normal non-sensitive text does not match defaults", () => {
  withConfigDir(() => {
    const patternSet = loadSensitivePatterns();

    assert.equal(findSensitiveMatch("filename", "objective.md", patternSet), undefined);
    assert.equal(findSensitiveMatch("path", "/repo/docs/objective.md", patternSet), undefined);
    assert.equal(findSensitiveMatch("content", "Write a normal local objective for the builder team.", patternSet), undefined);
  });
});
