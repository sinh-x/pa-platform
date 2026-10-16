#!/usr/bin/env python3
"""PAP-197 native installed inventory. stdlib only; never downloads at runtime.
Self-tests exercise these constructors/parsers/accounting, not Nix builds.
"""
import argparse
import datetime
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import unittest

TOOLS = dict(zip(('gh-axi', 'chrome-devtools-axi', 'quota-axi', 'lavish-axi'),
                 ('0.1.35', '0.1.38', '0.1.56', '0.1.67')))
OPTIONS = ('enableGhAxi', 'enableChromeDevtoolsAxi', 'enableQuotaAxi', 'enableLavishAxi')
SYSTEMS = ('x86_64-linux', 'aarch64-linux')
ALIASES = ('pa-platform', 'pa-core', 'ppa', 'opa', 'cpa', 'dpa', 'default')
INVALID = {'string': '"true"', 'integer': '1', 'null': 'null', 'list': '[]', 'set': '{}'}
STORE = re.compile(r'/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/\s]+')


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def selection(mask):
    require(type(mask) is int and 0 <= mask < 16, 'invalid selection mask')
    return {name: bool(mask & (1 << i)) for i, name in enumerate(TOOLS)}


def constructor(url, system, mask):
    require(system in SYSTEMS, 'unsupported system')
    values = selection(mask)
    settings = ' '.join(f'{option} = {str(values[name]).lower()};' for option, name in zip(OPTIONS, TOOLS))
    return f'let f = builtins.getFlake {json.dumps(url)}; in f.lib.mkPaPlatform "{system}" {{ {settings} }}'


def parse_store(text):
    paths = text.strip().splitlines()
    require(len(paths) == 1 and STORE.fullmatch(paths[0]), 'ambiguous/non-store build output')
    return paths[0]


def required_cases():
    cases = {'prerequisites', 'defaults:x86_64-linux', 'defaults:aarch64-linux'}
    for system in SYSTEMS:
        for mask in range(16):
            cases.add(f'eval:{system}:{mask}')
        for option, kind in itertools.product(OPTIONS, INVALID):
            cases.add(f'invalid:{system}:{option}:{kind}')
    for mask in range(16):
        cases.update((f'build:{mask}', f'installed:{mask}'))
    cases.update(f'pin:{name}' for name in (*TOOLS, 'chrome-devtools-mcp'))
    cases.add('inspection-tools')
    return cases


class Accounting:
    def __init__(self, required):
        self.required = set(required)
        self.cases = {}

    def passed(self, name, evidence):
        require(name in self.required and name not in self.cases, 'unknown/duplicate case')
        require(isinstance(evidence, dict) and evidence, 'empty case evidence')
        self.cases[name] = {'status': 'passed', 'evidence': evidence}

    def finish(self):
        require(set(self.cases) == self.required, 'omitted mandatory cases')
        return {'required': len(self.required), 'passed': len(self.cases), 'skipped': 0}


class Matrix:
    def __init__(self, output):
        self.repo = Path.cwd().resolve()
        self.output = Path(output)
        require(self.output.is_absolute() and not self.output.exists(), 'output must be absent absolute directory')
        require(not self.output.is_relative_to(self.repo), 'evidence must be outside checkout')
        require(self.output.parent.resolve() == self.output.parent, 'symlink evidence parent')
        self.output.mkdir(mode=0o700, parents=True)
        self.home = self.output / 'home'
        self.home.mkdir(mode=0o700)
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.home), 'NIX_REMOTE': 'daemon',
                    'TZ': 'UTC', 'LC_ALL': 'C.UTF-8'}
        self.url = f'git+file://{self.repo}?submodules=1'
        self.account = Accounting(required_cases())
        self.data = {'schema': 'pa-lavish-inventory/v1', 'status': 'failed', 'startedAt': utc(),
                     'repo': str(self.repo), 'commands': [], 'outputs': {}, 'evaluations': {}, 'tools': {},
                     'requiredCases': sorted(self.account.required), 'cases': self.account.cases}

    def command(self, argv, expected=0, timeout=3600):
        number = len(self.data['commands']) + 1
        record = {'argv': list(map(str, argv)), 'startedAt': utc()}
        self.data['commands'].append(record)
        start = time.monotonic()
        outpath, errpath = (self.output / f'command-{number:04}.{kind}' for kind in ('stdout', 'stderr'))
        with outpath.open('xb') as out, errpath.open('xb') as err:
            os.chmod(outpath, 0o600); os.chmod(errpath, 0o600)
            process = None
            code = 127
            try:
                try:
                    process = subprocess.Popen(record['argv'], stdout=out, stderr=err, env=self.env, start_new_session=True)
                except OSError:
                    err.write(b'ARTIFACT_RUNTIME_FAILED: command executable unavailable\n')
                if process is not None:
                    code = process.wait(timeout=timeout)
            except BaseException:
                if process is not None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL); process.wait()
                    code = process.returncode
                raise
            finally:
                record.update(endedAt=utc(), exit=code, durationMs=(time.monotonic()-start)*1000,
                              stdout=str(outpath), stderr=str(errpath))
        require(code == expected if expected is not None else code != 0, f'command {number} unexpected exit')
        return outpath.read_text(), errpath.read_text()

    def evaluate(self, expr):
        return json.loads(self.command(['nix', 'eval', '--impure', '--json', '--expr', expr, '--no-write-lock-file'])[0])

    def build(self, expr):
        return parse_store(self.command(['nix', 'build', '--impure', '--expr', expr, '--no-link',
                                         '--print-out-paths', '--no-write-lock-file', '--option', 'sandbox', 'true'])[0])

    def run(self):
        require(os.environ.get('PA_LAVISH_TEST_NETWORK') == 'loopback-only', 'runtime network policy missing')
        require(not any(k in os.environ for k in ('NODE_OPTIONS', 'NODE_PATH')) and
                not any(k.startswith('LAVISH_AXI_') for k in os.environ), 'unsafe inherited configuration')
        head = self.command(['git', 'rev-parse', 'HEAD'])[0].strip()
        require(re.fullmatch('[a-f0-9]{40}', os.environ.get('FEATURE_SHA', '')) and head == os.environ['FEATURE_SHA'], 'candidate mismatch')
        require(self.command(['git', 'status', '--porcelain=v1', '--untracked-files=all'])[0] == '', 'dirty candidate')
        require(self.evaluate('builtins.currentSystem') == SYSTEMS[0], 'native x86_64-linux required')
        sandbox = json.loads(self.command(['nix', 'config', 'show', '--json'])[0])['sandbox']['value']
        require(sandbox in (True, 'true'), 'sandbox required')
        versions = {name: self.command(args)[0].strip() for name, args in {
            'node': ['node', '--version'], 'pnpm': ['corepack', 'pnpm', '--version'],
            'python': ['python3', '--version'], 'nix': ['nix', '--version']}.items()}
        require(int(versions['node'].lstrip('v').split('.')[0]) >= 22, 'Node >=22 required')
        self.data.update(featureSha=head, flakeLockSha256=sha(self.repo/'flake.lock'), versions=versions)
        self.account.passed('prerequisites', {'sandbox': sandbox, 'versions': versions, 'featureSha': head})
        for system in SYSTEMS:
            for mask in range(16):
                expr = constructor(self.url, system, mask)
                row = self.evaluate(f'let p = ({expr}); in {{ drv = p.drvPath; selection = p.axiSelection; '
                                    'dependencies = map toString p.selectedAxiDependencies; '
                                    'tools = builtins.mapAttrs (_: t: toString t) p.selectedAxiTools; }')
                require(row['selection'] == selection(mask) and set(row['tools']) == {n for n,v in selection(mask).items() if v}, 'selection mismatch')
                row['nativeExecution'] = system == SYSTEMS[0]
                self.data['evaluations'][f'{system}/{mask}'] = row
                self.account.passed(f'eval:{system}:{mask}', row)
            names = '[ ' + ' '.join(json.dumps(n) for n in ALIASES) + ' ]'
            default_expr = f'''let f = builtins.getFlake {json.dumps(self.url)}; s = "{system}";
                pkgs = f.inputs.nixpkgs.legacyPackages.${{s}}; p = f.packages.${{s}};
                o = f.overlays.default pkgs pkgs; expected = (f.lib.mkPaPlatform s {{}});
                in assert expected.axiSelection == {self.nix_selection(0)};
                assert builtins.all (n: p.${{n}}.drvPath == expected.drvPath && p.${{n}}.selectedAxiTools == {{}}) {names};
                assert builtins.all (n: o.${{n}}.drvPath == expected.drvPath && o.${{n}}.selectedAxiTools == {{}})
                  (builtins.filter (n: n != "default") {names}); true'''
            require(self.evaluate(default_expr) is True, 'default/overlay mismatch')
            self.account.passed(f'defaults:{system}', {'aliases': ALIASES, 'overlay': True, 'selection': selection(0)})
            for option, (kind, value) in itertools.product(OPTIONS, INVALID.items()):
                expr = f'(let f = builtins.getFlake {json.dumps(self.url)}; in f.lib.mkPaPlatform "{system}" {{ {option} = {value}; }}).drvPath'
                _, err = self.command(['nix', 'eval', '--impure', '--raw', '--expr', expr, '--no-write-lock-file'], expected=None)
                require(f'option `{option}` must be a boolean' in err, 'wrong negative diagnostic')
                self.account.passed(f'invalid:{system}:{option}:{kind}', {'diagnostic': f'option `{option}` must be a boolean'})
        for name, version in {**TOOLS, 'chrome-devtools-mcp': '1.10.1'}.items():
            expr = f'(builtins.getFlake {json.dumps(self.url)}).packages.x86_64-linux.{name}'
            row = self.evaluate(f'let t = {expr}; in {{ version = t.version; drv = t.drvPath; node = toString t.node; nodeVersion = t.node.version; dependencies = map toString t.dependencies; }}')
            require(row['version'] == version, 'pin mismatch')
            row['store'] = self.build(expr)
            row['closure'] = self.command(['nix-store', '--query', '--requisites', row['store']])[0].splitlines()
            require(row['node'] in row['closure'] and all(d in row['closure'] for d in row['dependencies']), 'missing dependency closure')
            self.verify_records(name, row)
            self.data['tools'][name] = row
            self.account.passed(f'pin:{name}', row)
        self.data['inspection'] = {}
        for package, binary in [('strace', 'strace'), ('bubblewrap', 'bwrap')]:
            out = self.build(f'(builtins.getFlake {json.dumps(self.url)}).inputs.nixpkgs.legacyPackages.x86_64-linux.{package}.out')
            path = str(Path(out)/'bin'/binary)
            require(os.access(path, os.X_OK), 'inspection prerequisite absent')
            self.data['inspection'][binary] = path
        self.account.passed('inspection-tools', self.data['inspection'])
        for mask in range(16):
            out = self.build(constructor(self.url, SYSTEMS[0], mask))
            self.data['outputs'][str(mask)] = out
            self.account.passed(f'build:{mask}', {'store': out, 'drv': self.data['evaluations'][f'x86_64-linux/{mask}']['drv']})
            context = self.output/f'selection-{mask}.json'
            context.write_text(json.dumps({'output': out, 'mask': mask, 'evaluation': self.data['evaluations'][f'x86_64-linux/{mask}'], 'tools': self.data['tools']}))
            stdout, _ = self.command([str(Path(out)/'bin/pa-platform-node'), str(self.repo/'scripts/lavish-smoke/selection.mjs'), str(context)])
            evidence = json.loads(stdout)
            require(evidence['status'] == 'passed' and evidence['adapterLaunchCaptures'] == 12, 'installed environment incomplete')
            self.account.passed(f'installed:{mask}', evidence)
        require(len(set(self.data['outputs'].values())) == 16, 'non-distinct selections')
        require(sha(self.repo/'flake.lock') == self.data['flakeLockSha256'], 'lock drift')
        require(self.command(['git', 'rev-parse', 'HEAD'])[0].strip() == head, 'candidate drift')
        self.data['counts'] = self.account.finish()
        self.data['status'] = 'passed'

    @staticmethod
    def nix_selection(mask):
        return '{ ' + ' '.join(f'"{k}" = {str(v).lower()};' for k,v in selection(mask).items()) + ' }'

    def verify_records(self, name, row):
        source = self.repo/'nix/axi'/name
        installed = Path(row['store'])/'share'/name
        files = ['package.json', 'upstream-package.json', 'package-lock.json', 'integrity.json', 'THIRD_PARTY_NOTICES.md']
        if name == 'lavish-axi':
            files += ['adaptations.json', 'upstream-files.json']
        if name == 'chrome-devtools-mcp':
            files += ['bundled-packages.json']
        row['recordSha256'] = {}
        for namefile in files:
            require((source/namefile).read_bytes() == (installed/namefile).read_bytes(), 'installed provenance drift')
            row['recordSha256'][namefile] = sha(installed/namefile)
        inventory = json.loads((installed/'integrity.json').read_text())
        lock = json.loads((installed/'package-lock.json').read_text())
        require(set(lock['packages'])-{''} == {e['path'] for e in inventory['packages']}, 'transitive omissions')
        for entry in inventory['packages']:
            locked = lock['packages'][entry['path']]
            require(all(locked[k] == entry[v] for k,v in [('version','version'),('resolved','url'),('integrity','integrity')]) and not locked.get('hasInstallScript'), 'lock/integrity mismatch')
            for license in entry['licenseFiles']:
                require(sha(Path(row['store'])/'lib'/name/entry['path']/license['path']) == license['sha256'], 'license mismatch')
        if name == 'lavish-axi':
            assets = installed/'review'
            provenance = json.loads((assets/'provenance.json').read_text())
            require(provenance['version'] == '0.1.67' and provenance['outputSha256'] == sha(assets/'review.js'), 'adaptation digest mismatch')
            self.command([str(Path(row['node'])/'bin/node'), '--check', str(assets/'review.js')])
            row['adaptation'] = provenance
            for entry in json.loads((installed/'adaptations.json').read_text())['adaptations']:
                require(sha(installed/entry['path']) == entry['sha256'], 'adaptation input drift')

    def finish(self, error=None):
        self.data['endedAt'] = utc()
        self.data['missingCases'] = sorted(self.account.required-set(self.account.cases))
        if error:
            self.data['failure'] = {'kind': type(error).__name__, 'condition': str(error)}
        path = self.output/'inventory.json'
        path.write_text(json.dumps(self.data, indent=2)+'\n'); os.chmod(path, 0o600)
        print(json.dumps({'status': self.data['status'], 'passed': len(self.account.cases), 'required': len(self.account.required), 'inventory': str(path)}))


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--self-test', action='store_true')
    p.add_argument('--system', choices=(SYSTEMS[0],))
    p.add_argument('--output')
    return p


class SelfTests(unittest.TestCase):
    def test_all_masks_and_constructor(self):
        self.assertEqual(len({json.dumps(selection(m)) for m in range(16)}), 16)
        for m in range(16):
            expr = constructor('git+file:///synthetic"quote', SYSTEMS[0], m)
            self.assertEqual(expr.count(' = true;'), m.bit_count())
            self.assertEqual(expr.count(' = false;'), 4-m.bit_count())
            self.assertIn('synthetic\\"quote', expr)
        for m in (-1, 16, True, '1'):
            with self.assertRaises(ValueError): selection(m)
        with self.assertRaises(ValueError): constructor('x', 'darwin', 0)

    def test_real_output_parser(self):
        path = '/nix/store/'+'a'*32+'-lavish-axi-static-x86_64-unknown-linux-musl-0.1.67'
        self.assertEqual(parse_store(path+'\n'), path)
        for text in ('', '/tmp/a', path+'\n'+path, path+'/child', path.replace('a'*32, 'e'*32)):
            with self.assertRaises(ValueError): parse_store(text)

    def test_accounting_fails_closed(self):
        a = Accounting(required_cases())
        with self.assertRaises(ValueError): a.finish()
        with self.assertRaises(ValueError): a.passed('invented', {'x':1})
        for name in sorted(a.required): a.passed(name, {'selfTestOnly': True})
        self.assertEqual(a.finish()['passed'], 113)
        with self.assertRaises(ValueError): a.passed('prerequisites', {'x':1})
        self.assertEqual(sum(c.startswith('build:') for c in a.required), 16)
        self.assertEqual(sum(c.startswith('invalid:') for c in a.required), 40)

    def test_cli(self):
        a = parser().parse_args(['--system', 'x86_64-linux', '--output', '/synthetic/evidence'])
        self.assertEqual(a.system, SYSTEMS[0]); self.assertFalse(a.self_test)
        self.assertTrue(parser().parse_args(['--self-test']).self_test)


def main():
    args = parser().parse_args()
    if args.self_test:
        require(args.system is None and args.output is None, 'self-test is exclusive')
        return 0 if unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(SelfTests)).wasSuccessful() else 1
    require(args.system == SYSTEMS[0] and args.output, '--system and --output required')
    m = Matrix(args.output)
    error = None
    try: m.run()
    except Exception as e: error = e
    finally: m.finish(error)
    return 1 if error else 0


if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as e:
        print(f'ARTIFACT_RUNTIME_FAILED: matrix prerequisite/evidence failure: {e}', file=sys.stderr)
        sys.exit(7)
