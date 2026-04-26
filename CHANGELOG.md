# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-26

### Added

- Initial `@pa-platform/pa-core` runtime-neutral core package.
- Shared state modules for registry, tickets, bulletins, trash, documents, teams, health, codectx, signal, repo-health, activity, config, paths, repos, primer generation, and runtime API types.
- Core-owned Hono Agent API routes for health, tickets, bulletins, focus, teams, repos, documents, folders, config, deployments, repo metadata, timers, deploy routing, deploy status/events, deploy control, and self-update hooks.
- Shared `pa-core` CLI dispatcher with runtime-neutral parity for old `pa` core commands.
- Adapter-hooked deploy and serve execution surfaces.
- Nix flake package/devShell and `pa-core` wrapper.
- Fish completions for `pa-core`.
- GitHub CI, Nix build workflow, branch strategy metadata, and release tooling.

### Changed

- Runtime-specific spawning/provider/model behavior is adapter-owned instead of hardcoded in core.
- Old standalone inbox/sinh-inputs/ideas APIs are intentionally omitted in favor of ticket-based workflows.

[0.1.0]: https://github.com/sinh-x/pa-platform/releases/tag/v0.1.0
