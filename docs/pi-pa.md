# Pi Integration

`ppa` supports Pi 0.80.8 or newer. It does not install Pi, configure authentication, or copy credentials.

## Setup

Register the trusted `pi-pa` extension and the live `pa-platform-config` checkout in Pi's package settings:

```bash
ppa pi setup                 # user-global: ~/.pi/agent/settings.json
ppa pi setup --local         # project-local: .pi/settings.json
ppa pi status
ppa pi remove                # remove only the two PA package entries
```

Setup is confirmation-gated and idempotent. `--local` changes only the current project's settings. Removal preserves other Pi packages. The configured package sources are shown by `ppa pi status`; the extension source is the installed `pi-pa` package and the config source is `PA_PLATFORM_CONFIG_DIR`, `PA_PLATFORM_HOME`, or the current directory.

After editing skills or package metadata in the config checkout, run `/reload` in an active Pi session. New ordinary sessions discover the current files without reinstalling the packages.

## Managed Deployments

`ppa deploy` is isolated from ordinary Pi discovery. A managed deployment receives exactly the selected PA skills and the trusted PA extension through explicit resource arguments; it does not load unrelated user or project Pi skills/extensions. A setup registration does not weaken this isolation.

Pi provider/model precedence is CLI flags, selected mode `runtimes.pi`, team `runtimes.pi`, then Pi-local Pi configuration. Pi remains an optional runtime; OpenCode remains the default when no runtime is selected.

## Migration

Existing `ppa deploy` users can run `ppa pi setup` once at the desired scope. Existing Pi settings and packages are retained. To move from global to project-local registration, run `ppa pi setup --local`, verify with `ppa pi status --local`, then run `ppa pi remove` globally if the global registration is no longer wanted.

## Troubleshooting

- `Pi version must be 0.80.8 or later`: upgrade Pi and ensure `pi --version` is available on `PATH`.
- `Pi PA extension package path is missing`: reinstall/build pa-platform or use the current packaged `ppa`; inspect the path printed by `ppa pi status`.
- `PA config package path is missing`: set `PA_PLATFORM_CONFIG_DIR` to the existing `pa-platform-config` checkout.
- Skills changed but Pi still shows old content: run `/reload`; managed deployments pick up changes on their next invocation.
- Setup says `Already configured`: the two paths are already present. Use `ppa pi status` to inspect them.

The Nix output includes the `pi-pa` extension and runtime-host resources under `$out/share/pa-platform/packages/`, plus `ppa.fish` under `$out/share/fish/vendor_completions.d/`. It does not include the operator's config checkout or credentials.
