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
    for index, (old, new) in enumerate(replacements, 1):
        if text.count(old) != 1:
            raise SystemExit(f"PAP-298 pinned Pi patch no longer matches {relative} (replacement {index})")
        text = text.replace(old, new, 1)
    path.write_text(text)


def main(root: Path) -> None:
    coding = "packages/coding-agent/src/"
    declaration = "\t/** Trusted native host only; synchronous guard at the actual session output sink. */\n\tpaReadPublication?: (event: unknown) => void;\n"
    path_filter = "\t/** Native host resource composition; applied before extension factories execute. */\n\tpaExtensionPathFilter?: (path: string) => boolean;\n"
    patch(root, coding + "core/sdk.ts", [
        ("export interface CreateAgentSessionOptions {\n", "export interface CreateAgentSessionOptions {\n" + declaration),
        ("\t\tsessionStartEvent: options.sessionStartEvent,\n", "\t\tsessionStartEvent: options.sessionStartEvent,\n\t\tpaReadPublication: options.paReadPublication,\n"),
    ])
    patch(root, coding + "core/agent-session-services.ts", [
        ("export interface CreateAgentSessionFromServicesOptions {\n", "export interface CreateAgentSessionFromServicesOptions {\n" + declaration),
        ("\t\tsessionStartEvent: options.sessionStartEvent,\n", "\t\tsessionStartEvent: options.sessionStartEvent,\n\t\tpaReadPublication: options.paReadPublication,\n"),
    ])
    patch(root, coding + "main.ts", [
        ("export interface MainOptions {\n", "export interface MainOptions {\n" + declaration + path_filter),
        ("\t\t\t\textensionFactories,\n", "\t\t\t\textensionFactories,\n\t\t\t\tpaExtensionPathFilter: options?.paExtensionPathFilter,\n"),
        ("\t\t\tcustomTools: sessionOptions.customTools,\n", "\t\t\tcustomTools: sessionOptions.customTools,\n\t\t\tpaReadPublication: options?.paReadPublication,\n"),
        ('\tconst hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");\n', '''\tconst hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
\tif (hasRuntimeErrors && options?.paReadPublication) {
\t\t// The owned PPA host presents its existing bounded failure. Do not advise
\t\t// disabling its mandatory extension or dump untrusted diagnostic prose.
\t\tthrow new Error("Selected Pi startup checks failed.", { cause: runtime.diagnostics });
\t}
'''),
    ])
    patch(root, coding + "core/resource-loader.ts", [
        ("export interface DefaultResourceLoaderOptions {\n", "export interface DefaultResourceLoaderOptions {\n" + path_filter),
        ("export class DefaultResourceLoader implements ResourceLoader {\n", "export class DefaultResourceLoader implements ResourceLoader {\n\tprivate readonly paExtensionPathFilter?: (path: string) => boolean;\n"),
        ("\tconstructor(options: DefaultResourceLoaderOptions) {\n", "\tconstructor(options: DefaultResourceLoaderOptions) {\n\t\tthis.paExtensionPathFilter = options.paExtensionPathFilter;\n"),
        ("\n\t\tconst extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);", "\n\t\tconst extensionsResult = await loadExtensionsCached(this.filterPaExtensionPaths(extensionPaths), this.cwd, this.eventBus);"),
        ("this.loadFinalExtensionSet(extensionPaths, preTrustExtensions)", "this.loadFinalExtensionSet(this.filterPaExtensionPaths(extensionPaths), preTrustExtensions)"),
        ("\tprivate resolveExtensionLoadPath(path: string): string {", "\tprivate filterPaExtensionPaths(paths: string[]): string[] {\n\t\treturn this.paExtensionPathFilter ? paths.filter(path => this.paExtensionPathFilter!(this.resolveExtensionLoadPath(path))) : paths;\n\t}\n\n\tprivate resolveExtensionLoadPath(path: string): string {"),
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
        ('async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {\n', '''// Incurred read usage belongs to accounting, not the public result projection.
const paReadUsage = new WeakMap<FinalizedToolCallOutcome, NonNullable<ToolResultMessage["usage"]>>();
async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
\tif (finalized.toolCall.name === "read" && finalized.result.usage) paReadUsage.set(finalized, finalized.result.usage);
'''),
        ('function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {\n', '''function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
\tconst incurredReadUsage = paReadUsage.get(finalized);
\tpaReadUsage.delete(finalized);
'''),
        ('\t\tusage: finalized.result.usage,\n', '\t\tusage: incurredReadUsage ?? finalized.result.usage,\n'),
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
        ("// Core session management\n", '// Core session management\nexport const PA_READ_PUBLICATION_VERSION = "pa-read-publication/v1";\nexport const PA_EXTENSION_PATH_FILTER_VERSION = "pa-extension-path-filter/v1";\n'),
    ])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-selected-pi.py <writable-pinned-source>")
    main(Path(sys.argv[1]))
