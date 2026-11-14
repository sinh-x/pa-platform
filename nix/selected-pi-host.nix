# PAP-298: approved packaging inputs, not a selected runtime or a read grant.
# The caller supplies only the separately pinned host package set from flake.nix;
# no runtime environment or model argument can select these records.
{ pkgs }:
assert pkgs.pi-coding-agent.version == "1.4.0";
assert pkgs.nodejs_24.version == "24.21.0";
{
  pi = pkgs.pi-coding-agent;
  node = pkgs.nodejs_24;
  enabled = false;
  # Observed document layout only; CLI payload/lifecycle must be qualified before
  # a bootstrap is wired. These strings never authorize file access themselves.
  packageRelativeRoot = "lib/node_modules/pi-monorepo";
  documentRelativeRoots = [ "README.md" "docs" "examples" ];
}
