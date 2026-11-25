// Test-only environment separation. This is not an OS sandbox or native authority.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createTestEnvironment(root, source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => !/^(PA_|PI_|PPA_|OPA_|TREEHOUSE_|GIT_|NODE_TEST_CONTEXT$)/.test(key)));
  // Keep the already selected package-manager cache usable without borrowing PA state.
  env.COREPACK_HOME ??= join(source.XDG_CACHE_HOME || join(source.HOME || homedir(), '.cache'), 'node/corepack');
  Object.assign(env, {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    PA_PLATFORM_HOME: join(root, 'platform'),
    PA_PLATFORM_CONFIG: join(root, 'config/pa-platform'),
    PA_PLATFORM_DATA: join(root, 'data/pa-platform'),
    PA_AI_USAGE_HOME: join(root, 'usage'),
    PA_REGISTRY_DB: join(root, 'registry.db'),
    PI_CODING_AGENT_DIR: join(root, 'pi'),
  });
  return env;
}

export async function runIsolated(command, args, { env = process.env, cwd = process.cwd(), timeoutMs = 0, stdio = 'inherit' } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('Invalid test timeout');
  // Allocation failure is fatal; never run with the original environment as fallback.
  const root = mkdtempSync(join(tmpdir(), 'pa-regression-'));
  let child, timer, timedOut = false, receivedSignal = null, escalation;
  const grouped = process.platform !== 'win32';
  const stop = signal => {
    if (!child?.pid) return;
    try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const interrupt = signal => {
    receivedSignal ??= signal;
    stop(signal);
    escalation ??= setTimeout(() => stop('SIGKILL'), 2000);
  };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  try {
    const isolated = createTestEnvironment(root, env);
    for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'PA_PLATFORM_HOME', 'PA_PLATFORM_CONFIG', 'PA_PLATFORM_DATA', 'PA_AI_USAGE_HOME', 'PI_CODING_AGENT_DIR']) mkdirSync(isolated[key], { recursive: true });
    child = spawn(command, args, { cwd, env: isolated, stdio, detached: grouped });
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; interrupt('SIGTERM'); }, timeoutMs);
    const result = await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveResult({ code, signal }));
    });
    return { ...result, timedOut, interrupted: timedOut ? null : receivedSignal };
  } finally {
    clearTimeout(timer); clearTimeout(escalation);
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    // Descendants belong to this test group, never to the surrounding deployment.
    if (grouped) stop('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--' || !process.argv[3]) throw new Error('Usage: isolated-test-env.mjs -- command [arguments]');
  try {
    const result = await runIsolated(process.argv[3], process.argv.slice(4));
    process.exitCode = result.interrupted === 'SIGINT' ? 130 : result.interrupted === 'SIGTERM' ? 143 : result.timedOut ? 1 : result.code ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
  } catch {
    console.error('Isolated tests did not complete. Check the test fixture and toolchain; no ambient-environment fallback was attempted.');
    process.exitCode = 1;
  }
}
