# Reusable boot-time service. Importing this module alone has no host effect.
{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.pa-server;
  userName = if cfg.user == null then "" else cfg.user;
  account = config.users.users.${userName} or null;
  home = if account == null then "/var/empty" else account.home;
in
{
  options.services.pa-server = {
    enable = lib.mkEnableOption "the loopback PA Agent API server at boot";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.pa-platform;
      defaultText = lib.literalExpression "pa-platform.packages.\${pkgs.stdenv.hostPlatform.system}.pa-platform";
      description = "PA package providing bin/pa-core. The service uses the packaged foreground server.";
    };

    user = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "alice";
      description = ''
        Existing unprivileged account declared in users.users. Required when
        enabled; the module does not create accounts. HOME and the working
        directory come from that account, preserving its PA configuration and
        data paths. The home must be available at boot without an interactive login.
      '';
    };

    port = lib.mkOption {
      type = lib.types.ints.between 1 65535;
      default = 9848;
      example = 19848;
      description = "Local TCP port for the Agent API. The service binds only to 127.0.0.1.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = userName != "" && userName != "root" && account != null
          && account.uid != 0;
        message = "services.pa-server.user must name an existing non-root account declared in users.users.";
      }
      {
        assertion = lib.hasPrefix "/" home && home != "/" && home != "/var/empty";
        message = "services.pa-server.user must have a usable absolute users.users.<name>.home (not / or /var/empty).";
      }
    ];

    systemd.services.pa-server = {
      description = "PA Agent API (loopback)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      unitConfig.RequiresMountsFor = [ home ];
      startLimitIntervalSec = 60;
      startLimitBurst = 5;
      environment.HOME = home;
      serviceConfig = {
        Type = "simple";
        User = userName;
        WorkingDirectory = home;
        ExecStart = "${cfg.package}/bin/pa-core serve --host 127.0.0.1 --port ${toString cfg.port}";
        Restart = "on-failure";
        RestartSec = 5;
        KillSignal = "SIGTERM";
        KillMode = "control-group";
        TimeoutStopSec = 30;
        UMask = "0077";
        StandardOutput = "journal";
        StandardError = "journal";
      };
    };
  };
}
