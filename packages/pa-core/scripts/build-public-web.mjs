import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Build input only. Runtime never reads these environment variables or PATH.
// Nix supplies exact locked paths; source builds evaluate the same locked flake
// offline, with no dependency installation or implicit host executable fallback.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const data = process.env.PA_PUBLIC_WEB_BUILD_RUNTIME
  ? JSON.parse(process.env.PA_PUBLIC_WEB_BUILD_RUNTIME)
  : JSON.parse(execFileSync('nix', ['eval', '--offline', '--impure', '--json', '--expr',
    `let p=(builtins.getFlake ${JSON.stringify(`git+file://${root.replace(/\/$/, '')}`)}).inputs.nixpkgs.legacyPackages.${process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux'}; in { curl="\${p.lib.getBin p.curl}/bin/curl"; python="\${p.python3}/bin/python3"; ca="\${p.cacert}/etc/ssl/certs/ca-bundle.crt"; curlVersion=p.curl.version; pythonVersion=p.python3.version; }`],
    { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 16384 }));
for (const key of ['curl', 'python', 'ca']) {
  if (typeof data[key] !== 'string' || !data[key].startsWith('/nix/store/') || /[\r\n\0]/.test(data[key])) throw new Error('Public reader requires fixed Nix dependency paths');
  accessSync(data[key], key === 'ca' ? constants.R_OK : constants.X_OK);
}
const out = new URL('../dist/public-web/', import.meta.url);
mkdirSync(out, { recursive: true });
copyFileSync(new URL('../src/public-web/extract.py', import.meta.url), new URL('extract.py', out));
writeFileSync(new URL('runtime.json', out), JSON.stringify(data, null, 2) + '\n');
console.log(`Public reader workers: curl ${data.curlVersion}, Python ${data.pythonVersion}`);
