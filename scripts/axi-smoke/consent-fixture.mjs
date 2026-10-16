// Test-only writer for the private synthetic consent file. Never an operator
// consent-file mutator or production policy surface.
import assert from 'node:assert/strict';
import fs from 'node:fs';

export function writeConsentFixture(path, value) {
  try {
    const stat = fs.lstatSync(path);
    assert.equal(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), true);
    // Reset permission before rewriting after the deliberate mode-0400 denial.
    // writeFileSync's mode is applied only when a file is first created.
    fs.chmodSync(path, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(path, 0o600);
}
