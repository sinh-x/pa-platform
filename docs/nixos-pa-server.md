# NixOS PA Agent API service

PAP-336 provides a reusable **opt-in system service** for starting the packaged
Agent API at boot, without an interactive login. Importing the module does not
create a service until `services.pa-server.enable = true`.

The service runs as an explicitly selected existing unprivileged account, not
root. It binds only to `127.0.0.1`, defaults to port `9848`, and does not enable
CORS, open a firewall port, configure a proxy, or install an agent runtime.
Loopback is not per-user isolation: other local processes can reach the API;
existing endpoint authorization rules remain unchanged.

This is a source integration, not evidence of host activation or human UAT.
PAP-155's archived user-service proposal is not revived. Drgnfly-specific rollout
remains with NX-070 and needs its own authorization.

## Consumer configuration

Use a locked `pa-platform` flake input alongside the consumer's `nixpkgs` input.
For example, inside the consumer flake's
`outputs = { nixpkgs, pa-platform, ... }: { ... };`:

```nix
nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
  system = "x86_64-linux"; # aarch64-linux is also exposed
  modules = [
    ./configuration.nix
    pa-platform.nixosModules.pa-server
    {
      # alice must already be declared in users.users by the host configuration.
      services.pa-server = {
        enable = true;
        user = "alice";
        port = 19848; # omit to use 9848
      };
    }
  ];
};
```

`nixosModules.default` is an alias of `nixosModules.pa-server`. Neither requires
an overlay or a globally installed `pa-core`. The default package comes from
the PA flake's own locked package set for the consumer's host architecture.

| Option | Default | Contract |
| --- | --- | --- |
| `services.pa-server.enable` | `false` | Add `pa-server.service`, wanted by `multi-user.target`. |
| `services.pa-server.user` | `null` | Required when enabled. Must name an account declared in `users.users`, other than root or an explicit UID-zero account. No account is created. |
| `services.pa-server.port` | `9848` | Integer from 1 to 65535. Invalid values reject evaluation; availability and permission to bind are runtime checks. Prefer an unprivileged port (1024 or above); the module grants no low-port capability. |
| `services.pa-server.package` | PA flake's `packages.<system>.pa-platform` | Package supplying `bin/pa-core`. Use this to select a compatible custom PA build; it must provide that executable and the serve flags below. |

Example package override, inside the same consumer scope:

```nix
services.pa-server.package = pa-platform.lib.mkPaPlatform "x86_64-linux" {};
```

The service executes the selected package directly, in the foreground:

```text
<package>/bin/pa-core serve --host 127.0.0.1 --port <port>
```

It does not use a shell profile, `dtach`, `--background`, `--force`, the
network-facing `dev-pa-serve` helper, or a second server implementation.
There are deliberately no module options for a non-loopback host or arbitrary
extra CLI flags. The core server's endpoint and adapter contracts are unchanged.

## Account, paths and boot prerequisites

`HOME` and `WorkingDirectory` are set to `users.users.<user>.home`. NixOS validates
that this is an absolute path; the module also rejects `/` and `/var/empty`.
A `RequiresMountsFor` dependency orders the service after the home mount.
The directory must exist and be accessible to the selected account at boot;
login-unlocked/encrypted homes may need a different operator-owned arrangement.
The module does not create, migrate, copy or change ownership of data or secrets.

The existing [PA path resolver](../packages/pa-core/src/paths.ts) remains the
single owner of default paths. With no overrides, the service uses:

- Configuration: `~/.config/sinh-x/pa-platform`.
- Runtime data and PID file: `~/.local/share/pa-platform`.
- Shared usage data: `~/Documents/ai-usage`.

A system service does not inherit interactive shell variables, user profile PATH
or login-session credentials. If the operator already uses non-default PA paths,
configure the existing systemd environment explicitly, for example in a host
module (these are ordinary NixOS systemd options, not new PA module options):

```nix
systemd.services.pa-server.environment = {
  PA_PLATFORM_CONFIG = "/home/alice/.config/sinh-x/pa-platform";
  PA_PLATFORM_DATA = "/home/alice/.local/share/pa-platform";
  PA_AI_USAGE_HOME = "/home/alice/Documents/ai-usage";
};
```

Do not place credential values in Nix expressions or the world-readable Nix store.
Any credential provisioning or additional runtime tools/PATH are separately
operator-owned; enabling this module does not authenticate or provision them.
The selected package's wrapper still supplies its packaged runtime dependencies.

## Supervision, conflicts and recovery

Systemd supervises a `Type=simple` foreground process. It restarts failures after
five seconds, with at most five starts within sixty seconds. This is process
supervision, not an HTTP readiness check. Logs go to the journal; `UMask=0077`
protects newly created files. On stop, systemd sends SIGTERM to the service's
control group and allows thirty seconds before its normal forced termination.
There is no CLI `ExecStop` or PID-file-based process takeover. Existing core PID
bookkeeping and cleanup still run; see [server lifecycle](api/server-lifecycle.md).

Before a separately authorized activation, the operator should inspect any
manual/background/user-service server using the same PA data or port. The core
server refuses to replace an existing instance. Changing only the port does not
avoid the shared PID-file conflict when both processes use the same data root.
Never delete a PID file or use `--force` to conceal uncertain ownership. Resolve
an existing process through its confirmed owner before enabling this service.

For an already authorized installation, these commands **inspect** it:

```sh
systemctl status pa-server.service
journalctl -u pa-server.service -b
curl --fail http://127.0.0.1:19848/api/health # use the configured port
```

Starting, stopping or restarting it is a separate operator effect. Use the system
service manager, not `systemctl --user` or `pa-core serve stop`. If start-rate
limiting is reached, correct the verified account/home, permissions, package or
port conflict first; only then may an authorized operator reset the unit's failed
state and restart it. An HTTP health response does not prove deployment execution
or endpoint acceptance.

To roll back under separate host authority, set `services.pa-server.enable = false`
or restore the prior consumer configuration/package pin and apply that NixOS
configuration. Disabling removes this module's boot service on application; it
does not delete PA data or re-enable an earlier manual/user service. Removing an
import or editing source alone does not stop an already active host unit.

## Source verification and remaining qualification

Run from the PA repository without activating a host:

```sh
nix eval .#checks.x86_64-linux.pa-server-module.drvPath
nix eval .#checks.aarch64-linux.pa-server-module.drvPath
nix build .#checks.x86_64-linux.pa-server-module --no-link --print-build-logs
```

The interaction source inventory tracks the flake and its new boot-service owner.
The flake change adds only module exports and checks: it does not change CLI
forms, aliases, native bindings or the existing operator-only resource effects of
serve start/stop/restart. Serve status still permits stale PID cleanup and remains
a write, not a native observational read. The catalogue regression test preserves
these boundaries; renewing source digests grants no installed capability.

The Nix check evaluates disabled behavior, real package selection, port and account
validation, boot target, HOME/working directory, supervision, generated unit text
and absence of exposure/fork flags. Its generated unit uses an inert fixture
package to avoid requiring a full PA package build, and the fixture is never run.
The manual/release Nix workflow runs the x86_64 check; this is not ordinary PR CI.

The local PAP-336 implementation run passed 33 contracts on each architecture
and built the x86_64 fixture check. This is evaluation/build evidence, not a
running server, boot/reboot recovery, native aarch64 execution or host deployment.
A separately authorized rollout must verify the selected real package, account
and data access, effective loopback socket and port, health endpoint, journal,
stop/restart behavior and boot startup on the actual target. No such activation
or live qualification is performed by adding this module.
