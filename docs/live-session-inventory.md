# Local PPA session inventory

`ppa sessions` captures verified-open local Linux PPA/Pi deployments and their observed HerdR locations. Each invocation reads existing registry candidates and launch fingerprints, Linux process metadata, and available local HerdR servers again. It does not use the old registry display cap or require registry status `running`.

```sh
ppa sessions
ppa sessions --ticket PAP-281 --repo pa-platform
ppa sessions --deployment d-123abc --json
ppa sessions --all
```

Filters are exact AND intersections. `--ticket` uses the current registry association. `--repo` uses the canonical configured repository key matched to the recorded primary root, never directory-name inference. Unknown repository keys cannot match a repository filter. `--help` performs no collection. OPA does not offer this command.

## Reading the result

The table groups by HerdR session, workspace and tab, displaying scoped IDs, labels, deployment, ticket, team/mode, repository key, start time, registry status, process state, PID and pane. JSON emits one `ppa-sessions/v1` document containing the same factual rows, effective filters, capture start/end and coverage reasons. Neither format includes raw objectives, paths, arguments, environment, boot IDs or terminal contents. Labels are bounded, control-stripped and screened; sensitive-looking metadata is withheld.

**Open means alive, not actively executing work.** Waiting, blocked and completed-work-but-still-open sessions may all be open. Registry status is a separate recorded fact, not liveness or acceptance.

Only a matching existing private Pi launch record plus a rechecked non-zombie Linux incarnation is `verified-open`. A bare registry PID is insufficient. Missing/malformed/inaccessible evidence remains `unverified`; mismatched incarnations, zombies/dead states and established exits have separate diagnostic states. Procfs absence on a hidden or unreadable mount is not proof of exit. Default output omits nonverified candidates and counts them; `--all` exposes their reasons and separately labelled candidate PIDs. No identity records are created or backfilled.

HerdR mapping uses live foreground process ancestry and repeated scoped topology/process observations, not CWD, pane title, agent status or PID existence alone. A foreground shell does not attribute its background jobs. Pane IDs are only meaningful within the reported session/workspace/tab scope.

| Location state | Meaning |
| --- | --- |
| `mapped` | One stable observed process match with complete in-scope collection. |
| `qualified` | One directly rechecked match, **observed with HerdR coverage incomplete**; uniqueness is not established. |
| `ambiguous` | Multiple stable scoped process matches; no location selected. |
| `unmatched` | Complete in-scope scan without a foreground ancestry match. Non-HerdR sessions remain visible. |
| `unknown` | Missing, unstable, unavailable or incomplete evidence prevents a location claim. |

A pane move, replacement, rename, process change or server disappearance during recheck suppresses the unsettled match. A subsequent invocation collects anew. Even a complete capture describes an observation window, not a lock or a guarantee after return.

## Limits and failures

The first version supports local Linux and HerdR protocol 22. It reads at most 10,000 newest eligible registry candidates, 64 roster sessions, 1,024 panes overall, 64 ancestry levels, bounded socket payloads and a nominal ten-second observation window (three seconds initial processes, eight seconds topology, ten seconds final process recheck). Synchronous local filesystem/SQLite operations may exceed the nominal window. Reaching a cap or deadline discloses incomplete coverage rather than claiming absence. Missing launch records deliberately undercount the verified-open view. Other runtime/host variants and background attribution without evidence are unsupported.

No HerdR installation, stopped/inaccessible servers, malformed replies, concurrent exits and collection timeouts preserve independently verified process rows with honest location limitations. Partial and empty captures exit 0. Invalid options or a fatal required local metadata read exit nonzero, emit a bounded safe diagnostic to stderr, and emit no inventory rows. Successful JSON is exactly one stdout document with no appended prose.

The command does not start/attach/focus/rename/stop sessions, send input or signals, reconcile deployment lifecycle, modify registry/tickets/configuration, or create a daemon. It uses existing-only read-only registry access and directly connects only to existing current-user local HerdR sockets. There is no remote or dashboard endpoint. The exported `captureSessions` projection is the reuse boundary for separately authorized PAP-286 work; this feature does not implement that dashboard.

## Message examples and verification boundaries

Before this feature, there was no `ppa sessions` command; manual registry, process and HerdR reads were needed. After:

```text
Local PPA/Pi session inventory: 1 verified-open process(es).
Open means alive, not actively working or completed. Registry status is separate.
...
LOCATION: observed with HerdR coverage incomplete
```

Empty output explains that no matching sessions are shown and offers removing filters or `--all`. Usage/fatal diagnostics explain the outcome, condition, source, reason, correction and read-only retry prerequisite without exposing arbitrary exception text. Help/list/empty, partial warnings and usage/fatal failures are the affected message categories; unrelated status/registry messages are unchanged.

Source fixtures and software checks do not establish installed rollout, independent human readability or UAT acceptance. Those require separately recorded candidate-bound observations. No release, installation or lifecycle completion follows from this feature's source delivery.
