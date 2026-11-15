# PAP-298: the pinned production Pi payload with a synchronous native output
# fence. This is a build dependency, not a launcher, installation or read grant.
# Default PPA still uses its existing external-Pi route until an owned selected
# host is constructed and separately selected for rollout.
{ pkgs, host }:
host.pi.overrideAttrs (old: {
  pname = "pa-selected-pi";
  nativeBuildInputs = (old.nativeBuildInputs or []) ++ [ pkgs.python3 ];
  postPatch = (old.postPatch or "") + ''
    ${pkgs.python3}/bin/python3 ${../scripts/dev/patch-selected-pi.py} .
  '';
  passthru = (old.passthru or {}) // {
    paReadPublicationVersion = "pa-read-publication/v1";
    productionEnabled = false;
  };
})
