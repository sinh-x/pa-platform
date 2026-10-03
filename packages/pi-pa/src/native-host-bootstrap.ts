import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// Standalone Node only: never import this from the Pi extension graph or put it
// in NODE_OPTIONS. Pi's loader must supply its own classes and registries.
const dependencyRoot = new URL("../native-host/node_modules/", import.meta.url);
const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

// Source development still uses the workspace's pinned dev dependencies.
if (existsSync(dependencyRoot)) {
  const parentURL = new URL("../native-host/package.json", import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (hostPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
        return nextResolve(specifier, { ...context, parentURL });
      }
      return nextResolve(specifier, context);
    },
  });
}
