#!/usr/bin/env python3
"""Add PAP-298's synchronous session-output fence to the pinned Pi build only.

Every replacement is exact and unique. A different upstream source fails the
build instead of guessing a new publication boundary. No installed files are
patched, and no runtime flag/environment input selects a callback.
"""
from pathlib import Path
import sys


def patch(root: Path, relative: str, replacements: list[tuple[str, str]]) -> None:
    path = root / relative
    text = path.read_text()
    for old, new in replacements:
        if text.count(old) != 1:
            raise SystemExit(f"PAP-298 pinned Pi patch no longer matches {relative}")
        text = text.replace(old, new, 1)
    path.write_text(text)


def main(root: Path) -> None:
    coding = "packages/coding-agent/src/"
    declaration = "\t/** Trusted native host only; synchronous guard at the actual session output sink. */\n\tpaReadPublication?: (event: unknown) => void;\n"
    patch(root, coding + "core/sdk.ts", [
        ("export interface CreateAgentSessionOptions {\n", "export interface CreateAgentSessionOptions {\n" + declaration),
        ("\t\tsessionStartEvent: options.sessionStartEvent,\n", "\t\tsessionStartEvent: options.sessionStartEvent,\n\t\tpaReadPublication: options.paReadPublication,\n"),
    ])
    patch(root, coding + "core/agent-session-services.ts", [
        ("export interface CreateAgentSessionFromServicesOptions {\n", "export interface CreateAgentSessionFromServicesOptions {\n" + declaration),
        ("\t\tsessionStartEvent: options.sessionStartEvent,\n", "\t\tsessionStartEvent: options.sessionStartEvent,\n\t\tpaReadPublication: options.paReadPublication,\n"),
    ])
    patch(root, coding + "main.ts", [
        ("export interface MainOptions {\n", "export interface MainOptions {\n" + declaration),
        ("\t\t\tcustomTools: sessionOptions.customTools,\n", "\t\t\tcustomTools: sessionOptions.customTools,\n\t\t\tpaReadPublication: options?.paReadPublication,\n"),
        ('\tconst hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");\n', '''\tconst hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
\tif (hasRuntimeErrors && options?.paReadPublication) {
\t\t// The owned PPA host presents its existing bounded failure. Do not advise
\t\t// disabling its mandatory extension or dump untrusted diagnostic prose.
\t\tthrow new Error("Selected Pi startup checks failed.", { cause: runtime.diagnostics });
\t}
'''),
    ])
    patch(root, coding + "core/agent-session.ts", [
        ("export interface AgentSessionConfig {\n", "export interface AgentSessionConfig {\n" + declaration),
        ("\tprivate _eventListeners: AgentSessionEventListener[] = [];\n", "\tprivate _eventListeners: AgentSessionEventListener[] = [];\n\tprivate readonly _paReadPublication?: (event: unknown) => void;\n"),
        ("\t\tthis.agent = config.agent;\n", "\t\tthis.agent = config.agent;\n\t\tthis._paReadPublication = config.paReadPublication;\n"),
        ("\tprivate _emit(event: AgentSessionEvent): void {\n\t\tfor (const l of this._eventListeners) {", """\tprivate _emit(event: AgentSessionEvent): void {
\t\t// PAP-298: all awaited extension transforms finish before this fence.
\t\t// There is no await between the native guard and public listeners. The
\t\t// same event object is then used for session persistence and agent state.
\t\tif (this._paReadPublication) {
\t\t\ttry {
\t\t\t\tconst returned = this._paReadPublication(event) as unknown;
\t\t\t\tif (returned !== undefined) {
\t\t\t\t\tif (returned instanceof Promise) void returned.catch(() => {});
\t\t\t\t\tthrow new Error("asynchronous native publisher");
\t\t\t\t}
\t\t\t} catch {
\t\t\t\tthrow new Error("Selected Pi read publication could not be established.");
\t\t\t}
\t\t}
\t\tfor (const l of this._eventListeners) {"""),
    ])
    patch(root, "packages/agent/src/agent-loop.ts", [
        ("\t\tisError: finalized.isError,\n\t\t...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),\n\t\ttimestamp:", "\t\tisError: finalized.result.isError === true || finalized.isError,\n\t\t...(finalized.durationMs === undefined ? {} : { durationMs: finalized.durationMs }),\n\t\ttimestamp:"),
    ])
    patch(root, coding + "core/nested-tool-calls.ts", [
        ("\t\tscope.recorder.finish(record, outcome.isError, textOf(outcome.result));\n", ""),
        ("\t\treturn outcome;\n", """\t\toutcome.isError = outcome.result.isError === true || outcome.isError;
\t\t// Publication can withhold an otherwise successful nested result. Record
\t\t// only its settled status and payload, never a pre-publication success.
\t\tscope.recorder.finish(record, outcome.isError, textOf(outcome.result));
\t\treturn outcome;
"""),
    ])
    patch(root, coding + "index.ts", [
        ("// Core session management\n", '// Core session management\nexport const PA_READ_PUBLICATION_VERSION = "pa-read-publication/v1";\n'),
    ])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-selected-pi.py <writable-pinned-source>")
    main(Path(sys.argv[1]))
