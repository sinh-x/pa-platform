# Evaluation and generated-unit tests only: never starts a server or activates NixOS.
{ self, nixpkgs, pkgs, system }:
let
  inherit (pkgs) lib;
  # Keep the check independent of a full PA build. This inert executable is never
  # run; the real package default is checked separately at evaluation time.
  fixturePackage = pkgs.writeShellScriptBin "pa-core" "exit 99";
  base = {
    system.stateVersion = "26.05";
    boot.loader.grub.enable = false;
    fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
  };
  evaluate = modules: nixpkgs.lib.nixosSystem {
    inherit system;
    modules = [ base ] ++ modules;
  };
  baseline = evaluate [];
  disabled = evaluate [ self.nixosModules.pa-server ];
  disabledExplicit = evaluate [ self.nixosModules.default { services.pa-server.enable = false; } ];
  configured = overrides: extra: evaluate [
    self.nixosModules.pa-server
    {
      users.users.alice = { isNormalUser = true; home = "/home/alice"; };
      services.pa-server = {
        enable = true;
        user = "alice";
        package = fixturePackage;
      } // overrides;
    }
    extra
  ];
  enabled = configured {} {};
  custom = configured { port = 19848; } {};
  customHome = configured {} { users.users.alice.home = lib.mkForce "/srv/pa-user"; };
  realDefault = evaluate [ self.nixosModules.pa-server ];
  cfg = enabled.config;
  service = cfg.systemd.services.pa-server;
  unit = cfg.systemd.units."pa-server.service".text;
  failures = system: map (a: a.message) (builtins.filter (a: !a.assertion) system.config.assertions);
  moduleFailures = system: builtins.filter (message: lib.hasPrefix "services.pa-server.user" message) (failures system);
  invalidPort = port: !(builtins.tryEval (builtins.deepSeq (configured { inherit port; } {}).config.services.pa-server.port true)).success;
  rejectsAccount = overrides: extra: moduleFailures (configured overrides extra) != [];
  cases = {
    testDisabledByDefault = { expr = disabled.config.services.pa-server.enable; expected = false; };
    testDisabledNoService = { expr = disabled.config.systemd.services ? pa-server; expected = false; };
    testDefaultAliasDisabled = { expr = disabledExplicit.config.systemd.services ? pa-server; expected = false; };
    testDisabledNoAccounts = { expr = disabled.config.users.users; expected = baseline.config.users.users; };
    testDisabledNoGroups = { expr = disabled.config.users.groups; expected = baseline.config.users.groups; };
    testDisabledNoFirewallChanges = { expr = disabled.config.networking.firewall; expected = baseline.config.networking.firewall; };
    testNoFirewallChangesWhenEnabled = { expr = cfg.networking.firewall; expected = baseline.config.networking.firewall; };
    testDefaultPackage = { expr = realDefault.config.services.pa-server.package.drvPath; expected = self.packages.${system}.pa-platform.drvPath; };
    testDefaultPort = { expr = cfg.services.pa-server.port; expected = 9848; };
    testCustomPort = { expr = custom.config.systemd.services.pa-server.serviceConfig.ExecStart; expected = "${fixturePackage}/bin/pa-core serve --host 127.0.0.1 --port 19848"; };
    testPortBounds = { expr = map (port: (configured { inherit port; } {}).config.services.pa-server.port) [ 1 65535 ]; expected = [ 1 65535 ]; };
    testRejectInvalidPorts = { expr = builtins.all invalidPort [ 0 (-1) 65536 "9848" 9848.5 null true ]; expected = true; };
    testUserRequired = { expr = rejectsAccount { user = null; } {}; expected = true; };
    testEmptyUserRejected = { expr = rejectsAccount { user = ""; } {}; expected = true; };
    testUnknownUserRejected = { expr = rejectsAccount { user = "missing"; } {}; expected = true; };
    testRootRejected = { expr = rejectsAccount { user = "root"; } {}; expected = true; };
    testUidZeroRejected = { expr = rejectsAccount {} { users.users.alice.uid = 0; }; expected = true; };
    testInvalidHomesRejected = {
      expr = builtins.all (home: rejectsAccount {} { users.users.alice.home = lib.mkForce home; }) [ "/" "/var/empty" ];
      expected = true;
    };
    testHomeTypeValidation = {
      expr = builtins.all (home: !(builtins.tryEval (builtins.deepSeq
        (configured {} { users.users.alice.home = lib.mkForce home; }).config.users.users.alice.home true)).success) [ "relative" "" ];
      expected = true;
    };
    testValidConfiguration = { expr = failures enabled; expected = []; };
    testForegroundPackageOverride = { expr = service.serviceConfig.ExecStart; expected = "${fixturePackage}/bin/pa-core serve --host 127.0.0.1 --port 9848"; };
    testBootTarget = { expr = service.wantedBy; expected = [ "multi-user.target" ]; };
    testUser = { expr = service.serviceConfig.User; expected = "alice"; };
    testHome = { expr = service.environment.HOME; expected = "/home/alice"; };
    testWorkingDirectory = { expr = service.serviceConfig.WorkingDirectory; expected = "/home/alice"; };
    testCustomHome = {
      expr = with customHome.config.systemd.services.pa-server; [ environment.HOME serviceConfig.WorkingDirectory unitConfig.RequiresMountsFor ];
      expected = [ "/srv/pa-user" "/srv/pa-user" [ "/srv/pa-user" ] ];
    };
    testRestartPolicy = { expr = with service; [ serviceConfig.Restart serviceConfig.RestartSec startLimitIntervalSec startLimitBurst ]; expected = [ "on-failure" 5 60 5 ]; };
    testDirectShutdown = { expr = with service.serviceConfig; [ Type KillSignal KillMode TimeoutStopSec ]; expected = [ "simple" "SIGTERM" "control-group" 30 ]; };
    testNoPidTakeover = { expr = builtins.any (key: service.serviceConfig ? ${key}) [ "ExecStop" "PIDFile" "ExecStartPre" ]; expected = false; };
    testJournal = { expr = with service.serviceConfig; [ StandardOutput StandardError UMask ]; expected = [ "journal" "journal" "0077" ]; };
    testNoUserService = { expr = cfg.systemd.user.services ? pa-server; expected = false; };
    testGeneratedUnit = {
      expr = builtins.all (text: lib.hasInfix (builtins.unsafeDiscardStringContext text) unit) [
        "ExecStart=${fixturePackage}/bin/pa-core serve --host 127.0.0.1 --port 9848"
        "User=alice" "WorkingDirectory=/home/alice" "HOME=/home/alice"
        "RequiresMountsFor=/home/alice" "Restart=on-failure" "KillSignal=SIGTERM"
      ];
      expected = true;
    };
    testNoExposureOrForkFlags = {
      expr = builtins.any (text: lib.hasInfix text unit) [ "--background" "--force" "--cors" "0.0.0.0" "--local-review" "--dev" ];
      expected = false;
    };
  };
  results = lib.runTests cases;
  generatedUnit = pkgs.writeText "pa-server.service" unit;
in
if results != [] then throw "PA server module contract failures: ${builtins.toJSON results}"
else pkgs.runCommand "pa-server-module-contract" {
  passthru.testNames = builtins.attrNames cases;
} ''
  mkdir -p $out
  cp ${generatedUnit} $out/pa-server.service
  printf '%s\n' '${toString (builtins.length (builtins.attrNames cases))} evaluation contracts passed (${system}); no service activated.' > $out/result
''
