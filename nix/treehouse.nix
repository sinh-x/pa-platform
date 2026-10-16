# Private PPA dependency, independent of the host's Treehouse package/PATH.
{ lib, stdenv, fetchurl, autoPatchelfHook }:
let
  version = "3.1.3";
  releases = {
    x86_64-linux = { arch = "amd64"; hash = "sha256-eMggxYcr+dnT6xm77ddeSAS5JYyGIjiZP6Fgz50hXtg="; };
    aarch64-linux = { arch = "arm64"; hash = "sha256-njShP9MPo4VVIL+krTVdOs3hOdtB+6KeeL3TMWM91hc="; };
  };
  release = releases.${stdenv.hostPlatform.system};
in stdenv.mkDerivation {
  pname = "ppa-treehouse";
  inherit version;
  src = fetchurl {
    url = "https://github.com/kunchenguid/treehouse/releases/download/v${version}/treehouse-v${version}-linux-${release.arch}.tar.gz";
    inherit (release) hash;
  };
  sourceRoot = ".";
  dontBuild = true;
  nativeBuildInputs = [ autoPatchelfHook ];
  buildInputs = [ stdenv.cc.cc.lib ];
  installPhase = ''
    runHook preInstall
    install -Dm755 treehouse "$out/bin/treehouse"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    test "$("$out/bin/treehouse" --version)" = "v${version}"
  '';
  meta = {
    description = "Exact Treehouse runtime contract for PPA";
    homepage = "https://github.com/kunchenguid/treehouse";
    license = lib.licenses.mit;
    platforms = builtins.attrNames releases;
  };
}
