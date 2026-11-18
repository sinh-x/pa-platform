#!/usr/bin/env python3
"""Installed CLI/transport observations only; never full AC qualification or UAT.

No installed-module/provenance reads, configuration edits, native decisions,
live tickets, provider calls, implementation launches or installation effects.
Every stateful CLI check uses fresh temporary ai-usage/data/registry paths.
"""
import http.client
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time

EXPECTED = "0.1.173-pap316.1"
PPA = shutil.which("ppa")
if not PPA:
    raise SystemExit("ppa is unavailable")
ROOT = Path(tempfile.mkdtemp(prefix="pap316-installed-surface-"))
ENV = {key: os.environ[key] for key in ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL") if key in os.environ}
ENV.update({"TZ": "Asia/Saigon", "LANG": "en_US.UTF-8", "NO_COLOR": "1"})
CASES = []
PROCESSES = []


def environment(name):
    root = ROOT / name
    root.mkdir(mode=0o700)
    usage, data = root / "usage", root / "data"
    usage.mkdir(mode=0o700)
    data.mkdir(mode=0o700)
    env = {**ENV, "PA_AI_USAGE_HOME": str(usage), "PA_PLATFORM_DATA": str(data), "PA_REGISTRY_DB": str(usage / "registry.db")}
    return root, env


def command(args, env, name, stdin=None):
    result = subprocess.run([PPA, *args], input=stdin, text=True, capture_output=True, env=env, timeout=30)
    for suffix, value in (("stdout", result.stdout), ("stderr", result.stderr)):
        path = ROOT / f"{name}.{suffix}"
        path.write_text(value)
        path.chmod(0o600)
    return result


def observed(name, check):
    try:
        detail = check()
        CASES.append({"id": name, "status": "passed", "detail": detail})
    except Exception as error:
        CASES.append({"id": name, "status": "failed", "errorType": type(error).__name__, "detail": str(error)[:500]})
        raise


def no_database(root):
    assert not list(root.rglob("*.db*")), "a rejected-input check created a database"


def reserve_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request_http(port, path, method="GET", body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        return response.status, dict((name.lower(), value) for name, value in response.getheaders()), json.loads(raw)
    finally:
        connection.close()


def server(args, root, env, health):
    port = reserve_port()
    stdout = open(root / "server.stdout", "w")
    stderr = open(root / "server.stderr", "w")
    process = subprocess.Popen([PPA, *[str(port) if arg == "PORT" else arg for arg in args]], env=env, stdout=stdout, stderr=stderr)
    PROCESSES.append((process, stdout, stderr))
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError("installed server exited before health observation")
        try:
            status, _, value = request_http(port, health)
            if status == 200:
                return port, value
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.1)
    raise AssertionError("installed server did not become observable within 15 seconds")


def stop_servers():
    for process, stdout, stderr in reversed(PROCESSES):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        stdout.close()
        stderr.close()


def main():
    root, env = environment("cli")
    result = command(["--version"], env, "version")
    observed("installed-readable-version", lambda: version(result))
    selection = command(["template", "list", "--format", "json"], env, "selection")
    assert selection.returncode == 0, "installed template inspection failed"
    registry = json.loads(selection.stdout)["registry"]
    assert registry["root"] == "/home/sinh/git-repos/sinh-x/tools/pa-platform-config", "clean child selected a different PAPC root"
    CASES.append({"id": "installed-selected-config", "status": "observed-not-authority", "detail": registry})
    for name, raw in (
        ("unknown-actor", '{"schemaVersion":"pa-local-review/v1","action":"show","subjectSha256":"' + "a" * 64 + '","actor":"operator"}'),
        ("duplicate-action", '{"schemaVersion":"pa-local-review/v1","action":"show","action":"request","subjectSha256":"' + "a" * 64 + '"}'),
        ("unsupported-effect", '{"schemaVersion":"pa-local-review/v1","action":"publish","subjectSha256":"' + "a" * 64 + '"}'),
    ):
        result = command(["document", "review", "--request-stdin"], env, name, raw)
        observed(name, lambda result=result: rejected(result, "DOCUMENT_INPUT"))
    no_database(root)
    result = command(["deploy", "analyst", "--mode", "analyze", "--dry-run"], env, "analyst-preflight")
    observed("omitted-analyst-native-selection", lambda: profile_blocker(result))
    assert not list((root / "usage").iterdir()), "unsupported Analyst dry-run allocated deployment artifacts"
    no_database(root)
    result = command(["serve", "--local-review", "--host", "0.0.0.0", "--force"], env, "unsafe-server-bind")
    observed("nonloopback-opt-in-denied", lambda: bind_blocker(result))
    assert not list((root / "data").iterdir()), "invalid server bind changed PID/data state"

    dedicated, dedicated_env = environment("dedicated")
    port, health = server(["document", "review", "serve", "--port", "PORT"], dedicated, dedicated_env, "/v1/health")
    observed("dedicated-health-trust", lambda: health_trust(health))
    observed("dedicated-origin-denial", lambda: origin_denial(port, "/v1/review"))
    observed("dedicated-invalid-grammar", lambda: malformed(port, "/v1/review"))
    no_database(dedicated)

    general, general_env = environment("general")
    # The real CLI enables registry watchers. Keep their registry INSIDE the
    # ai-usage sandbox and back up an empty fixture before native schema setup.
    with closing(sqlite3.connect(general_env["PA_REGISTRY_DB"])) as initial:
        with closing(sqlite3.connect(general / "before-server.db")) as backup:
            initial.backup(backup)
    port, _ = server(["serve", "--host", "127.0.0.1", "--port", "PORT", "--local-review", "--cors"], general, general_env, "/api/health")
    baseline = registry_snapshot(general_env)
    observed("general-origin-denial-despite-cors", lambda: origin_denial(port, "/api/documents/local-review"))
    observed("general-invalid-grammar", lambda: malformed(port, "/api/documents/local-review"))
    observed("general-credential-denial", lambda: credentials(port))
    assert registry_snapshot(general_env) == baseline, "rejected review requests changed the fixture registry"
    assert baseline["events"] == 0, "surface checks created deployment events"
    again = command(["--version"], env, "version-after")
    assert again.stdout == result_version(), "installed version changed during observations"
    assert Path(PPA).resolve() == INITIAL_PHYSICAL, "installed executable changed during observations"
    return {"root": registry["root"], "sha": registry["configRevision"]}


def registry_snapshot(env):
    connection = sqlite3.connect(f"file:{env['PA_REGISTRY_DB']}?mode=ro", uri=True)
    try:
        connection.execute("PRAGMA query_only=ON")
        schema = connection.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").fetchall()
        assert not any(name.startswith("handoff_review_") for _, name, _ in schema), "a review journal was initialized"
        return {"schema": schema, "events": connection.execute("SELECT count(*) FROM registry_events").fetchone()[0]}
    finally:
        connection.close()


def result_version():
    return f"ppa {EXPECTED}\n"


def version(result):
    assert result.returncode == 0 and result.stdout == result_version() and not result.stderr, "installed readable version mismatch"
    return {"binary": PPA, "physical": str(INITIAL_PHYSICAL), "version": EXPECTED, "exactSourceProvenance": "not-established"}


def rejected(result, code):
    assert result.returncode == 1, "invalid review request did not reject"
    value = json.loads(result.stdout)
    assert value["code"] == code, "unexpected review failure code"
    return {"exit": result.returncode, "code": code}


def profile_blocker(result):
    assert result.returncode == 1 and "CAPABILITY_PROFILE" in result.stdout + result.stderr, "unsupported native Analyst selection did not fail early"
    return {"exit": result.returncode, "code": "CAPABILITY_PROFILE", "deploymentArtifacts": "absent"}


def bind_blocker(result):
    assert result.returncode == 1 and "numeric bind 127.0.0.1 or ::1" in result.stdout + result.stderr, "unsafe opt-in bind did not reject"
    return {"exit": result.returncode, "pidEffects": "absent"}


def health_trust(value):
    assert value == {"schemaVersion": "pa-local-review/v1", "trust": "local-unverified"}, "dedicated health trust differs"
    return value


def origin_denial(port, path):
    status, headers, value = request_http(port, path, "POST", "{}", {"Content-Type": "application/json", "Origin": "null"})
    assert status == 403 and value["code"] == "LOCAL_REVIEW_ORIGIN", "Origin was not denied"
    assert "access-control-allow-origin" not in headers, "review route enabled CORS"
    return {"http": status, "code": value["code"], "cors": "absent"}


def malformed(port, path):
    status, headers, value = request_http(port, path, "POST", "{}", {"Content-Type": "application/json"})
    assert status == 400 and value["code"] == "DOCUMENT_INPUT", "invalid native grammar was not rejected"
    assert "access-control-allow-origin" not in headers, "review error enabled CORS"
    return {"http": status, "code": value["code"]}


def credentials(port):
    status, _, value = request_http(port, "/api/documents/local-review", "POST", "{}", {"Content-Type": "application/json", "Authorization": "Bearer fixture"})
    assert status == 400 and value["code"] == "LOCAL_REVIEW_HEADERS", "general review accepted credentials"
    return {"http": status, "code": value["code"]}


INITIAL_PHYSICAL = Path(PPA).resolve()
status = "failed"
selection = None
try:
    selection = main()
    status = "passed-with-qualification-limits"
finally:
    stop_servers()
    report = {"schemaVersion": "pap316-installed-surface-observations/v1", "status": status, "evidenceClass": "installed-cli-and-http-surface-only-not-full-AC-qualification", "binary": PPA, "physical": str(INITIAL_PHYSICAL), "version": EXPECTED, "selectedConfig": selection, "cases": CASES, "evidenceRoot": str(ROOT), "nativeDecisionIssued": False, "liveStateMutation": False, "configurationChanged": False, "fullAcceptanceEstablished": False, "humanUat": "not-performed", "provenanceFile": "not-read-host-multilink-policy-denial"}
    output = ROOT / "observations.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    output.chmod(0o600)
    print(json.dumps(report, indent=2))
