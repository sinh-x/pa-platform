/** Synthetic source tests only: no operator configuration or runtime closure. */
export const renderEnvironment = {
  PATH: (process.env.PATH ?? "").split(":")
    .filter(path => /^\/nix\/store\/[a-z0-9]{32}-coreutils[^/]*\/bin$/.test(path)).join(":"),
};

/** The in-process dispatcher reads process.env. Restore every removed entry,
 * even on failure; tests in a file run serially and files have separate workers.
 */
export async function isolatedArtifactEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const entries = Object.entries(process.env).filter(([key]) =>
    ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH",
      "PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR"].includes(key)
    || key.startsWith("LAVISH_AXI_") || key.startsWith("PA_ARTIFACT_"));
  for (const [key] of entries) delete process.env[key];
  try { return await run(); }
  finally { for (const [key, value] of entries) process.env[key] = value; }
}
