#!/usr/bin/env python3
"""Offline provenance generator; never imports/executes package code or extracts paths.

Usage: python3 generate-inventory.py LOCK ARCHIVE_CACHE OUTPUT
ARCHIVE_CACHE contains <archive SHA-256 hex>.tgz files previously fetched and
SRI-verified from the isolated lock. Dependency resolution is a separate,
ignore-scripts, package-lock-only operation, never part of the Nix build.
"""
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tarfile

lock_path, cache, output = map(Path, sys.argv[1:])
lock = json.loads(lock_path.read_text())
archives = {}
for archive in sorted(cache.glob("*.tgz")):
    data = archive.read_bytes()
    archives["sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()] = data
records = []
notices = ["# Lavish isolated runtime closure licenses\n\nExact archive license texts; no package lifecycle code was executed.\n"]
bundled = []
for path, entry in sorted(lock["packages"].items()):
    if not path:
        continue
    assert not entry.get("hasInstallScript"), path
    assert entry["resolved"].startswith("https://registry.npmjs.org/")
    data = archives[entry["integrity"]]
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        manifest = json.load(tar.extractfile("package/package.json"))
        assert manifest["version"] == entry["version"]
        assert not any(k in manifest.get("scripts", {}) for k in ("preinstall", "install", "postinstall"))
        files = []
        for member in tar.getmembers():
            if not member.isfile():
                continue
            if manifest["name"] == "lavish-axi":
                content = tar.extractfile(member).read()
                bundled.append({"path": member.name.removeprefix("package/"), "sha256": hashlib.sha256(content).hexdigest()})
            if re.search(r"licen[cs]e|copying|notice", Path(member.name).name, re.I):
                content = tar.extractfile(member).read()
                name = member.name.removeprefix("package/")
                files.append({"path": name, "sha256": hashlib.sha256(content).hexdigest()})
                notices.append(f"\n## {path} — {manifest['version']} — {name}\n\n```text\n{content.decode('utf-8')}\n```\n")
        assert files and manifest.get("license") == entry.get("license"), path
        records.append({"path": path, "name": manifest["name"], "version": entry["version"],
                        "url": entry["resolved"], "integrity": entry["integrity"],
                        "sha256": "sha256-" + base64.b64encode(hashlib.sha256(data).digest()).decode(),
                        "license": manifest["license"], "licenseFiles": files})
output.mkdir(parents=True, exist_ok=True)
(output / "integrity.json").write_text(json.dumps({"schemaVersion": 1, "packages": records}, indent=2) + "\n")
(output / "THIRD_PARTY_NOTICES.md").write_text("".join(notices))
(output / "upstream-files.json").write_text(json.dumps({"schemaVersion": 1, "archiveSha256": "b04bd8eea71ece824ca5dc6837c98de04372b76ca6a28fe6e1a1ab025e50acfd", "files": bundled}, indent=2) + "\n")
