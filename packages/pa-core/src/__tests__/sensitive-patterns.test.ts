import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertNoSensitiveMatch, findSensitiveMatch, getSensitivePatternsConfigPath, loadSensitivePatterns, readGuardedLocalTextFile, SensitiveInputBlockedError } from "../sensitive-patterns.js";

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

test("built-in content defaults catch documented sensitive classes", () => {
  withConfigDir(() => {
    const patternSet = loadSensitivePatterns();
    const cases = [
      { name: "seed phrase", value: "seed phrase: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima" },
      { name: "ssh private key", value: "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEYDATA\n-----END OPENSSH PRIVATE KEY-----" },
      { name: "ssh public key", value: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyOnly test@example" },
      { name: "bearer token", value: "Authorization: Bearer FAKE_TOKEN_VALUE_1234567890" },
      { name: "provider key", value: "provider key sk-fakeProviderKeyValue1234567890" },
      { name: "bot token", value: "bot token 123456:FAKE_BOT_TOKEN_VALUE_12345678901234567890" },
      { name: "api token assignment", value: "api_key = FAKE_API_KEY_VALUE_1234567890" },
    ];

    for (const item of cases) {
      assert.equal(findSensitiveMatch("content", item.value, patternSet)?.source, "built-in", item.name);
    }
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

test("built-in sensitive content errors do not include matched content", () => {
  withConfigDir(() => {
    const patternSet = loadSensitivePatterns();

    assert.throws(
      () => assertNoSensitiveMatch("content", "Authorization: Bearer FAKE_TOKEN_VALUE_1234567890", patternSet),
      (error: unknown) => {
        assert.equal(error instanceof SensitiveInputBlockedError, true);
        assert.equal((error as Error).message.includes("FAKE_TOKEN_VALUE"), false);
        assert.equal((error as Error).message.includes("1234567890"), false);
        assert.match((error as Error).message, /Blocked sensitive content input/);
        assert.match((error as Error).message, /built-in sensitive defaults/);
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
    assert.equal(findSensitiveMatch("content", "Fix review findings for sensitive file guardrails on the current feature branch without changing ticket status.", patternSet), undefined);
  });
});

test("guarded local text-file reader preserves normal local text reads", () => {
  withConfigDir((configDir) => {
    const objectivePath = join(configDir, "objective.md");
    const content = "Write a normal local objective for the builder team.";
    writeFileSync(objectivePath, content);

    assert.equal(readGuardedLocalTextFile(objectivePath), content);
  });
});

test("guarded local text-file reader blocks sensitive filename before reading", () => {
  withConfigDir((configDir) => {
    const missingSensitivePath = join(configDir, ".env");

    assert.throws(
      () => readGuardedLocalTextFile(missingSensitivePath),
      (error: unknown) => {
        assert.equal(error instanceof SensitiveInputBlockedError, true);
        assert.match((error as Error).message, /Blocked sensitive filename input/);
        assert.doesNotMatch((error as Error).message, /ENOENT|\.env/);
        return true;
      },
    );
  });
});

test("guarded local text-file reader blocks sensitive path before reading", () => {
  withConfigDir((configDir) => {
    writeFileSync(getSensitivePatternsConfigPath(), ["paths:", "  - 'fake-sensitive-dir'", ""].join("\n"));
    const missingSensitivePath = join(configDir, "fake-sensitive-dir", "objective.md");

    assert.throws(
      () => readGuardedLocalTextFile(missingSensitivePath),
      (error: unknown) => {
        assert.equal(error instanceof SensitiveInputBlockedError, true);
        assert.match((error as Error).message, /Blocked sensitive path input/);
        assert.doesNotMatch((error as Error).message, /ENOENT|fake-sensitive-dir/);
        return true;
      },
    );
  });
});

test("guarded local text-file reader blocks sensitive content after reading", () => {
  withConfigDir((configDir) => {
    writeFileSync(getSensitivePatternsConfigPath(), ["contents:", "  - 'FAKE_PRIVATE_MARKER_[0-9]+'", ""].join("\n"));
    const objectivePath = join(configDir, "objective.md");
    writeFileSync(objectivePath, "contains FAKE_PRIVATE_MARKER_123 only");

    assert.throws(
      () => readGuardedLocalTextFile(objectivePath),
      (error: unknown) => {
        assert.equal(error instanceof SensitiveInputBlockedError, true);
        assert.match((error as Error).message, /Blocked sensitive content input/);
        assert.doesNotMatch((error as Error).message, /FAKE_PRIVATE_MARKER|123/);
        return true;
      },
    );
  });
});
