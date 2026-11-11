import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, accessSync, realpathSync, constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build input only. Runtime never reads these environment variables or PATH.
// Nix supplies exact locked paths; source builds evaluate the same locked flake
// offline. Nix-free code-only builds explicitly record development host tools;
// those outputs are NOT pinned/installed qualification artifacts.
const root = fileURLToPath(new URL('../../../', import.meta.url));
function developmentWorkers() {
  const locate = name => {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      const path = join(dir, name);
      try { if (isAbsolute(path)) { accessSync(path, constants.X_OK); return realpathSync(path); } } catch {}
    }
    throw new Error(`Missing development reader dependency: ${name}`);
  };
  const curl = locate('curl'), python = locate('python3');
  console.warn('Development-only host reader workers: not pinned Nix/installed qualification');
  return { kind: 'development-host-tools', curl, python, ca: '/etc/ssl/certs/ca-certificates.crt',
    curlVersion: execFileSync(curl, ['-q', '--version'], { encoding: 'utf8' }).split('\n')[0],
    pythonVersion: execFileSync(python, ['-I', '--version'], { encoding: 'utf8' }).trim() };
}
let data;
try { data = process.env.PA_PUBLIC_WEB_BUILD_RUNTIME
  ? JSON.parse(process.env.PA_PUBLIC_WEB_BUILD_RUNTIME)
  : JSON.parse(execFileSync('nix', ['eval', '--offline', '--impure', '--json', '--expr',
    `let p=(builtins.getFlake ${JSON.stringify(`git+file://${root.replace(/\/$/, '')}`)}).inputs.nixpkgs.legacyPackages.${process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux'}; in { curl="\${p.lib.getBin p.curl}/bin/curl"; python="\${p.python3}/bin/python3"; ca="\${p.cacert}/etc/ssl/certs/ca-bundle.crt"; curlVersion=p.curl.version; pythonVersion=p.python3.version; }`],
    { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 16384 }));
} catch (error) { if (error.code !== 'ENOENT') throw error; data = developmentWorkers(); }
for (const key of ['curl', 'python', 'ca']) {
  if (typeof data[key] !== 'string' || !(data.kind === 'development-host-tools' ? isAbsolute(data[key]) : data[key].startsWith('/nix/store/')) || /[\r\n\0]/.test(data[key])) throw new Error('Public reader requires fixed Nix dependency paths');
  accessSync(data[key], key === 'ca' ? constants.R_OK : constants.X_OK);
}
const out = new URL('../dist/public-web/', import.meta.url);
mkdirSync(out, { recursive: true });
copyFileSync(new URL('../src/public-web/extract.py', import.meta.url), new URL('extract.py', out));
writeFileSync(new URL('runtime.json', out), JSON.stringify(data, null, 2) + '\n');
console.log(`Public reader workers: curl ${data.curlVersion}, Python ${data.pythonVersion}`);
