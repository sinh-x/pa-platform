#!/usr/bin/env python3
"""PAP-240 installed matrix coordinator; stdlib only, no success/skip fixtures."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

SYSTEMS = ("x86_64-linux", "aarch64-linux")
TOOLS = {"gh-axi": "0.1.35", "chrome-devtools-axi": "0.1.38", "quota-axi": "0.1.56"}
OPTIONS = ("enableGhAxi", "enableChromeDevtoolsAxi", "enableQuotaAxi")
ALIASES = ("pa-platform", "pa-core", "opa", "cpa", "dpa", "ppa", "default")
RUNTIME_CASES = ("installed-path", "installed-metadata", "installed-prerequisites",
                 "installed-policy-denials", "startup-authority", "quota-denials",
                 "quota-providers", "quota-states", "quota-pinned-expiry", "browser-concurrent",
                 "browser-stop", "browser-cancel", "browser-exit", "browser-failure",
                 "browser-collision", "browser-foreign", "browser-idle", "observed-effects")
MAX_LOG = 2 * 1024 * 1024
MAX_LINES = 10000


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def check(value):
    if not value:
        raise AssertionError("required assertion failed")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def selection(mask):
    return {name: bool(mask & (1 << index)) for index, name in enumerate(TOOLS)}


def constructor(url, system, mask):
    settings = " ".join(f"{option} = {'true' if mask & (1 << i) else 'false'};" for i, option in enumerate(OPTIONS))
    return f'let f = builtins.getFlake {json.dumps(url)}; in f.lib.mkPaPlatform "{system}" {{ {settings} }}'


class Matrix:
    def __init__(self, log, chrome, root):
        self.log = log
        self.json = log.with_suffix(".json")
        check(self.log != self.json)
        self.root = root
        self.chrome = chrome
        self.repo = Path.cwd().resolve()
        self.url = f"git+file://{self.repo}?submodules=1"
        self.bytes = self.lines = 0
        self.data = {"schemaVersion": 1, "ticket": "PAP-240", "startedAt": utc(),
                     "status": "failed", "systems": list(SYSTEMS), "commands": [], "cases": {},
                     "nativeOutputs": {}, "evaluations": {}, "dryRuns": {}, "tools": {},
                     "scope": "installed outputs, real local Chrome, synthetic quota; not live-provider correctness or final acceptance"}
        # Fail on any omitted case, even when a helper exits 0 with partial JSON.
        self.required = {"host", "chrome", "sandbox", "core-dependencies", "defaults", "plugin-defaults", "trace-tools"}
        for system in SYSTEMS:
            self.required.update(f"eval:{system}:{mask}" for mask in range(8))
            self.required.add(f"aliases:{system}")
            for option in OPTIONS:
                for kind in ("string", "integer", "null"):
                    self.required.add(f"invalid:{system}:{option}:{kind}")
        for mask in range(8):
            self.required.update((f"dry-run:{mask}", f"build:{mask}", f"run:{mask}"))
        self.required.update(f"tool:{name}" for name in (*TOOLS, "chrome-devtools-mcp"))
        self.required.update(RUNTIME_CASES)
        self.env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"),
                    "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
                    "LANG": "C.UTF-8", "NIX_REMOTE": "daemon"}
        for directory in ("home", "config", "cache"):
            (root / directory).mkdir(mode=0o700)
        self.log.touch(mode=0o600, exist_ok=False)
        self.json.touch(mode=0o600, exist_ok=False)

    def emit(self, text, final=False):
        # Reserve room for the terminal failure record even on a bounds failure.
        # No raw provider/browser/auth output is copied into durable evidence.
        text = text + "\n"
        length = len(text.encode())
        check(self.bytes + length <= (MAX_LOG if final else MAX_LOG - 4096) and self.lines + 1 <= MAX_LINES - (0 if final else 1))
        self.bytes += length
        self.lines += 1
        with self.log.open("a") as stream:
            stream.write(text)
        print(text, end="", flush=True)

    def case(self, name, evidence=None):
        check(name in self.required and name not in self.data["cases"])
        self.data["cases"][name] = {"status": "passed", "evidence": evidence}
        self.emit(f"case={name} status=passed")

    def command(self, argv, *, expected=0, timeout=3600, env=None):
        item = {"argv": list(map(str, argv)), "startedAt": utc()}
        self.data["commands"].append(item)
        self.emit(f"command={len(self.data['commands'])} start={item['startedAt']} argv={json.dumps(item['argv'])}")
        start = time.monotonic()
        # Spool rather than an unbounded pipe. Logs contain only length/digest;
        # raw command output is transient, never a secret-bearing evidence file.
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            try:
                process = subprocess.Popen(item["argv"], env=env or self.env, stdout=out, stderr=err, start_new_session=True)
            except OSError:
                code = 127
            else:
                try:
                    code = process.wait(timeout=timeout)
                except (subprocess.TimeoutExpired, InterruptedError):
                    # Only this coordinator-created command session is signaled.
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    code = 124
            item.update(endedAt=utc(), exit=code, durationMs=round((time.monotonic() - start) * 1000))
            lengths = [stream.tell() for stream in (out, err)]
            item["outputBytes"] = lengths
            check(max(lengths) <= 8 * 1024 * 1024)
            out.seek(0)
            err.seek(0)
            stdout, stderr = out.read(), err.read()
            item["stdoutSha256"] = hashlib.sha256(stdout).hexdigest()
            item["stderrSha256"] = hashlib.sha256(stderr).hexdigest()
            self.emit(f"command={len(self.data['commands'])} end={item['endedAt']} exit={code} ms={item['durationMs']} outputBytes={lengths}")
            check(code in expected if isinstance(expected, tuple) else (code == expected if expected is not None else code != 0))
            return stdout.decode(), stderr.decode()

    def evaluate(self, expression):
        out, _ = self.command(["nix", "eval", "--impure", "--json", "--expr", expression, "--no-write-lock-file"])
        return json.loads(out)

    def build(self, expression, dry=False):
        args = ["nix", "build", "--impure", "--expr", expression, "--no-link", "--no-write-lock-file", "--option", "sandbox", "true"]
        args += ["--dry-run"] if dry else ["--print-out-paths"]
        out, _ = self.command(args)
        if dry:
            return None
        paths = out.strip().splitlines()
        check(len(paths) == 1 and re.fullmatch(r"/nix/store/[a-z0-9]{32}-[^\s]+", paths[0]))
        check(Path(paths[0]).is_dir())
        return paths[0]

    def inspection_binary(self, name):
        executable = {"strace": "strace", "bubblewrap": "bwrap"}[name]
        # strace's default outputs include man; select the pinned executable
        # output explicitly instead of accepting an arbitrary first store path.
        output = self.build(f'(builtins.getFlake {json.dumps(self.url)}).inputs.nixpkgs.legacyPackages.{SYSTEMS[0]}.{name}.out')
        binary = Path(output) / "bin" / executable
        check(binary.is_file() and os.access(binary, os.X_OK))
        return str(binary)

    def run(self):
        self.data["featureSha"] = self.command(["git", "rev-parse", "HEAD"])[0].strip()
        self.data["flakeLockSha256"] = digest(self.repo / "flake.lock")
        check(self.evaluate("builtins.currentSystem") == SYSTEMS[0])
        self.case("host", SYSTEMS[0])
        # This is an actual executable probe, not the version discovered in requirements.
        out, _ = self.command([str(self.chrome), "--version"], timeout=15)
        check("Chrome" in out and re.search(r"\d+\.\d+\.\d+\.\d+", out))
        check(not any(sentinel in out for sentinel in ("secret-sentinel", "identity-sentinel", "path-sentinel")))
        self.data["chrome"] = {"operatorExecutable": str(self.chrome), "resolvedExecutable": str(self.chrome.resolve()), "version": out.strip()}
        self.case("chrome", self.data["chrome"])
        config = json.loads(self.command(["nix", "config", "show", "--json"])[0])
        check(config["sandbox"]["value"] is True or config["sandbox"]["value"] == "true")
        self.case("sandbox", {"configured": config["sandbox"]["value"], "buildOverride": "true"})
        core = json.loads((self.repo / "packages/pa-core/package.json").read_text())
        check(not any("axi" in name for field in ("dependencies", "devDependencies", "optionalDependencies") for name in core.get(field, {})))
        self.case("core-dependencies")
        check(self.evaluate(f'((builtins.getFlake {json.dumps(self.url)}).lib.mkPaPlatform "{SYSTEMS[0]}" {{}}).axiSelection') == selection(0))
        self.case("defaults", selection(0))
        for system in SYSTEMS:
            for mask in range(8):
                expression = constructor(self.url, system, mask)
                result = self.evaluate(f'let p = ({expression}); in {{ drv = p.drvPath; selection = p.axiSelection; plugins = p.pluginSelection; dependencies = map toString p.selectedAxiDependencies; tools = builtins.mapAttrs (_: t: toString t) p.selectedAxiTools; }}')
                check(result["selection"] == selection(mask))
                check(result["plugins"] == {"pi-vimmode": False, "proper-base": False})
                check(set(result["tools"]) == {name for name, selected in selection(mask).items() if selected})
                self.data["evaluations"][f"{system}/{mask}"] = result
                self.case(f"eval:{system}:{mask}", result)
                if system == SYSTEMS[1]:
                    self.build(expression, dry=True)
                    self.data["dryRuns"][str(mask)] = {"system": system, "drv": result["drv"], "nativeExecution": False}
                    self.case(f"dry-run:{mask}", self.data["dryRuns"][str(mask)])
            alias_expr = f'''let f = builtins.getFlake {json.dumps(self.url)}; s = "{system}";
              p = f.packages.${{s}}; pkgs = f.inputs.nixpkgs.legacyPackages.${{s}};
              o = f.overlays.default pkgs pkgs; expected = (f.lib.mkPaPlatform s {{}}).drvPath;
              names = {json.dumps(list(ALIASES)).replace(',', '')};
              in assert builtins.all (n: p.${{n}}.drvPath == expected && p.${{n}}.selectedAxiTools == {{}}) names;
                 assert builtins.all (n: o.${{n}}.drvPath == expected && o.${{n}}.selectedAxiTools == {{}}) (builtins.filter (n: n != "default") names); true'''
            check(self.evaluate(alias_expr) is True)
            self.case(f"aliases:{system}")
            for option in OPTIONS:
                for kind, value in (("string", '"true"'), ("integer", "1"), ("null", "null")):
                    expression = f'(let f = builtins.getFlake {json.dumps(self.url)}; in f.lib.mkPaPlatform "{system}" {{ {option} = {value}; }}).drvPath'
                    _, err = self.command(["nix", "eval", "--impure", "--raw", "--expr", expression, "--no-write-lock-file"], expected=None)
                    check(f"option `{option}` must be a boolean" in err)
                    self.case(f"invalid:{system}:{option}:{kind}")
        # Four plugin selections are evaluation regressions here; full native
        # binding/plugin proof is owned by the unchanged baseline smoke.
        for system in SYSTEMS:
            for vim in (False, True):
                for proper in (False, True):
                    expression = f'(let f = builtins.getFlake {json.dumps(self.url)}; in f.lib.mkPaPlatform "{system}" {{ enablePiVimMode = {str(vim).lower()}; enableProperBase = {str(proper).lower()}; }}).axiSelection'
                    check(self.evaluate(expression) == selection(0))
        self.case("plugin-defaults", {"evaluatedSelectionsPerSystem": 4, "systems": 2, "nativeProof": "separate baseline smoke"})
        for mask in range(8):
            output = self.build(constructor(self.url, SYSTEMS[0], mask))
            self.data["nativeOutputs"][str(mask)] = output
            self.case(f"build:{mask}", {"store": output, "drv": self.data["evaluations"][f"{SYSTEMS[0]}/{mask}"]["drv"]})
        check(len(set(self.data["nativeOutputs"].values())) == 8)
        for name, version in {**TOOLS, "chrome-devtools-mcp": "1.10.1"}.items():
            expression = f'(builtins.getFlake {json.dumps(self.url)}).packages.{SYSTEMS[0]}.{name}'
            record = self.evaluate(f'let t = {expression}; in {{ version = t.version; node = toString t.node; nodeVersion = t.node.version; dependencies = map toString t.dependencies; drv = t.drvPath; }}')
            check(record["version"] == version)
            check(tuple(map(int, record["nodeVersion"].split(".")[:2])) >= (22, 19))
            locked_node = self.evaluate(f'toString (builtins.getFlake {json.dumps(self.url)}).inputs.nixpkgs.legacyPackages.{SYSTEMS[0]}.nodejs_22')
            check(record["node"] == locked_node)
            if name == "gh-axi":
                locked_gh = self.evaluate(f'toString (builtins.getFlake {json.dumps(self.url)}).inputs.nixpkgs.legacyPackages.{SYSTEMS[0]}.gh')
                check(record["dependencies"] == [locked_gh])
            elif name == "chrome-devtools-axi":
                locked_mcp = self.evaluate(f'toString (builtins.getFlake {json.dumps(self.url)}).packages.{SYSTEMS[0]}.chrome-devtools-mcp')
                check(record["dependencies"] == [locked_mcp])
            else:
                check(record["dependencies"] == [])
            output = self.build(expression)
            record["store"] = output
            closure = self.command(["nix-store", "--query", "--requisites", output])[0].splitlines()
            check(record["node"] in closure and all(dep in closure for dep in record["dependencies"]))
            record["closure"] = closure
            self.verify_records(name, output)
            self.data["tools"][name] = record
            self.case(f"tool:{name}", record)
        check(len({record["store"] for record in self.data["tools"].values()}) == 4)
        # Both inspection tools are flake-locked, not opportunistic npm tools.
        binaries = {}
        for name in ("strace", "bubblewrap"):
            binaries[name] = self.inspection_binary(name)
        self.case("trace-tools", binaries)
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"outputs": self.data["nativeOutputs"], "evaluations": self.data["evaluations"], "tools": self.data["tools"], "chrome": str(self.chrome), "root": str(self.root)}))
        all_output = Path(self.data["nativeOutputs"]["7"])
        helper = self.repo / "scripts/axi-smoke/runtime.mjs"
        trace = self.root / "runtime.trace"
        runtime_env = {**self.env, "PA_DEPLOYMENT_ID": "d-axismoke", "PA_DEPLOYMENT_DIR": str(self.root / "d-axismoke")}
        (self.root / "d-axismoke").mkdir(mode=0o700)
        # No provider/public network is reachable. The trace observes attempted
        # network and exec effects too, rather than calling isolation 'zero'.
        stdout, _ = self.command([binaries["bubblewrap"], "--unshare-net", "--unshare-pid", "--new-session", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--bind", str(self.root), str(self.root),
                                 binaries["strace"], "-f", "-qq", "-s", "512", "-e", "trace=process,network,openat", "-o", str(trace),
                                 str(all_output / "bin/pa-platform-node"), str(helper), str(manifest)], timeout=900, env=runtime_env, expected=(0, 1))
        runtime = json.loads(stdout)
        self.data["runtime"] = runtime
        check(not runtime.get("cleanupFailure"))
        check(set(runtime["cases"]) == set(RUNTIME_CASES) - {"observed-effects"})
        for name, evidence in runtime["cases"].items():
            check(evidence["status"] == "passed")
            self.case(name, evidence)
        for mask in range(8):
            check(str(mask) in runtime["nativeRuns"])
            self.case(f"run:{mask}", runtime["nativeRuns"][str(mask)])
        self.audit_trace(trace, runtime)
        check(digest(self.repo / "flake.lock") == self.data["flakeLockSha256"])
        check(self.command(["git", "rev-parse", "HEAD"])[0].strip() == self.data["featureSha"])
        check(self.required == set(self.data["cases"]))
        self.data["counts"] = {"nativeBuildRuns": len(runtime["nativeRuns"]), "evaluations": len(self.data["evaluations"]), "nonNativeDryRuns": len(self.data["dryRuns"]),
                               "requiredCases": len(self.required), "passedCases": len(self.data["cases"])}
        self.data["status"] = "passed"

    def verify_records(self, name, output):
        installed = Path(output) / "share" / name
        source = self.repo / "nix/axi" / name
        hashes = {}
        for filename in ("package.json", "upstream-package.json", "package-lock.json", "integrity.json", "THIRD_PARTY_NOTICES.md"):
            check((installed / filename).read_bytes() == (source / filename).read_bytes())
            hashes[filename] = digest(installed / filename)
        lock = json.loads((installed / "package-lock.json").read_text())
        inventory = json.loads((installed / "integrity.json").read_text())
        check(lock["lockfileVersion"] == 3)
        check(set(lock["packages"]) - {""} == {entry["path"] for entry in inventory["packages"]})
        for entry in inventory["packages"]:
            locked = lock["packages"][entry["path"]]
            check(all(locked[key] == entry[other] for key, other in (("resolved", "url"), ("integrity", "integrity"), ("version", "version"))))
            check(entry["integrity"].startswith("sha512-") and entry["sha256"].startswith("sha256-") and entry["license"] and entry["licenseFiles"])
            check(not locked.get("hasInstallScript", False))
            package = Path(output) / "lib" / name / entry["path"]
            check(json.loads((package / "package.json").read_text())["version"] == entry["version"])
            for license in entry["licenseFiles"]:
                check(digest(package / license["path"]) == license["sha256"])
        if name == "chrome-devtools-mcp":
            check((installed / "bundled-packages.json").read_bytes() == (source / "bundled-packages.json").read_bytes())
        self.data.setdefault("inputRecords", {})[name] = {"hashes": hashes, "resolvedPackages": len(inventory["packages"])}

    def audit_trace(self, trace, runtime):
        check(trace.is_file() and 0 < trace.stat().st_size <= 128 * 1024 * 1024)
        counts = {"runtimeDownloads": 0, "selfUpdates": 0, "nonLoopbackConnectAttempts": 0, "githubMutations": 0, "hostCredentialAccesses": 0, "globalHookWrites": 0}
        execs = 0
        with trace.open() as stream:
            for line in stream:
                if "execve(" in line:
                    execs += 1
                    command = re.search(r'execve\("([^"\n]+)"', line)
                    check(command is not None)
                    if re.search(r'/(npm|npx|pnpm|curl|wget)("|/)', line):
                        counts["runtimeDownloads"] += 1
                    if re.search(r'"(self-update|selfupdate|update)"', line):
                        counts["selfUpdates"] += 1
                    if re.search(r'/(gh|gh-axi)"', line) and re.search(r'"(merge|create|delete|dispatch|set|edit)"', line):
                        counts["githubMutations"] += 1
                if "openat(" in line:
                    # Synthetic consent/provider roots are inside self.root. A
                    # read of an operator discovery/credential file is a failure,
                    # even though namespaces already block external requests.
                    if re.search(r'/(?:\.codex/(?:auth|config)\.(?:json|toml)|\.claude/(?:\.credentials\.json|settings\.json)|\.config/gh/hosts\.yml|\.netrc|\.npmrc)"', line) and str(self.root) not in line:
                        counts["hostCredentialAccesses"] += 1
                    if re.search(r'O_WRONLY|O_RDWR|O_CREAT', line) and re.search(r'/\.(?:pi|claude)/(?:skills|extensions|settings|hooks)', line):
                        counts["globalHookWrites"] += 1
                if any(call in line for call in ("connect(", "sendto(", "sendmsg(")) and ("AF_INET," in line or "AF_INET6," in line):
                    if not re.search(r'inet_addr\("127\.[0-9.]+"\)|inet_pton\(AF_INET6, "::1"', line):
                        counts["nonLoopbackConnectAttempts"] += 1
        check(execs > 0)
        check(all(value == 0 for value in counts.values()))
        counters = runtime["effectCounters"]
        check(all(counters[name] == 0 for name in ("delegatedRefresh", "inference", "routing", "mcpTelemetry")))
        check(counters["credentialReads"] > 0 and counters["providerRequests"] > 0 and counters["providerInvocations"] > 0)
        self.case("observed-effects", {**counts, **counters, "execveObservations": execs, "traceSha256": digest(trace), "observation": "strace plus fixture filesystem/HTTP/subprocess instrumentation"})

    def finish(self, error=None):
        self.data["endedAt"] = utc()
        self.data["missingCases"] = sorted(self.required - set(self.data["cases"]))
        if error:
            # Never serialize raw exceptions (could contain synthetic credentials).
            self.data["failure"] = {"kind": type(error).__name__, "commandNumber": len(self.data["commands"])}
        self.emit(f"axi-smoke status={self.data['status']} passed={len(self.data['cases'])}/{len(self.required)}", final=True)
        check(self.log.stat().st_size <= MAX_LOG)
        self.data["logSha256"] = digest(self.log)
        payload = json.dumps(self.data, indent=2) + "\n"
        if len(payload.encode()) > 2 * 1024 * 1024:
            self.data["status"] = "failed"
            payload = json.dumps({"schemaVersion": 1, "status": "failed", "failure": "JSON evidence bound exceeded", "missingCases": self.data["missingCases"], "commandCount": len(self.data["commands"]), "logSha256": self.data["logSha256"]}) + "\n"
        check(not any(sentinel in payload or sentinel in self.log.read_text() for sentinel in ("secret-sentinel", "identity-sentinel", "path-sentinel", "synthetic-only-never-a-vendor-token")))
        self.json.write_text(payload)


def main():
    # Shell enforces exact CLI; enforce it here as well for direct calls.
    args = sys.argv[1:]
    check(len(args) == 9 and args[:5] == ["--system", SYSTEMS[0], "--eval-system", SYSTEMS[1], "--all-selections"] and args[5] == "--chrome" and args[7] == "--log-file")
    deployment = Path(os.environ["PA_DEPLOYMENT_DIR"]).resolve(strict=True)
    check(deployment.name == os.environ["PA_DEPLOYMENT_ID"])
    evidence = deployment / "evidence"
    evidence.mkdir(mode=0o700, exist_ok=True)
    log = Path(args[8]).absolute()
    check(not log.is_symlink() and not log.with_suffix(".json").is_symlink())
    check(log.parent.resolve() == evidence.resolve() and log.suffix == ".log")
    chrome = Path(args[6])
    check(chrome.is_absolute())
    def interrupted(signum, frame):
        raise InterruptedError("bounded coordinator cancellation")
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    with tempfile.TemporaryDirectory(prefix="pap240-axi-") as temporary:
        matrix = Matrix(log, chrome, Path(temporary))
        error = None
        try:
            matrix.run()
        except Exception as failure:
            error = failure
        finally:
            matrix.finish(error)
        return 1 if error or matrix.data["status"] != "passed" else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as failure:
        print(f"AXI smoke evidence/prerequisite failure ({type(failure).__name__}); no passing result", file=sys.stderr)
        sys.exit(1)
