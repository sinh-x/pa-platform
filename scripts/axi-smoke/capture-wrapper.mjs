// Capture only exports from an installed makeWrapper Bash script. Never use
// /bin/sh: its POSIX mode forbids shadowing the special builtin exec.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { join } from 'node:path';

export function captureInstalledWrapper(output, name, env, effects = { readFileSync: fs.readFileSync, spawnSync: cp.spawnSync }) {
  const wrapper = join(output, 'bin', name);
  const shebang = effects.readFileSync(wrapper, 'utf8').split('\n', 1)[0];
  // Use the exact declared store interpreter, not an opportunistic host shell
  // or an arbitrary first word from an unsupported shebang.
  const match = /^#! ?(\/nix\/store\/[a-z0-9]{32}-bash-[^/\s]+\/bin\/bash)(?: (-e))?$/.exec(shebang);
  assert.notEqual(match, null);
  // Node's pipe sockets can trigger Bash's remote-shell startup heuristic.
  // Disable unrelated host startup files before sourcing only this wrapper.
  const args = ['--noprofile', '--norc', ...(match[2] ? [match[2]] : []), '-c', 'exec() { printf "%s\\n%s\\n" "$PATH" "${PA_AXI_PATH-}"; }; . "$1"', 'wrapper-capture', wrapper];
  const result = effects.spawnSync(match[1], args, { env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  return result.stdout.trimEnd().split('\n');
}
