import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserArgumentsAllowed } from "./axi-browser.js";
import { quotaEnvironmentAllowed, quotaReadArguments, runManagedQuota, type QuotaEffects } from "./axi-quota.js";

export const AXI_VERSIONS = {
  "gh-axi": "0.1.35",
  "chrome-devtools-axi": "0.1.38",
  "quota-axi": "0.1.56",
} as const;
export type AxiTool = keyof typeof AXI_VERSIONS;
export type AxiDiagnosticCode = "AXI_GH_AUTH_REQUIRED" | "AXI_CHROME_REQUIRED" | "AXI_QUOTA_CONSENT_REQUIRED" | "AXI_POLICY_REJECTED";
const DIAGNOSTICS: Record<AxiDiagnosticCode, string> = {
  AXI_GH_AUTH_REQUIRED: "Operator-managed gh authentication is required for this operation.",
  AXI_CHROME_REQUIRED: "An executable absolute PA_AXI_CHROME_EXECUTABLE is required; no browser is provisioned.",
  AXI_QUOTA_CONSENT_REQUIRED: "Deployment-bound PA_AXI_QUOTA_CONSENT is required before any profile or provider access.",
  AXI_POLICY_REJECTED: "The operation is not admitted by the managed AXI policy.",
};
export function axiDiagnostic(code: AxiDiagnosticCode): string { return `${code}: ${DIAGNOSTICS[code]}\n`; }

/** Nix supplies only selected managed bins/dependencies. No discovery, auth,
 * provisioning, skill installation or GitHub operation occurs at launch.
 * This is PATH exposure, not a sandbox or a grant of PA action authority.
 */
export function axiRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const prefix = env["PA_AXI_PATH"];
  if (!prefix) return { ...env };
  const paths = prefix.split(":");
  if (paths.some((path) => !isAbsolute(path) || /[\0\r\n]/.test(path))) throw new Error(axiDiagnostic("AXI_POLICY_REJECTED").trim());
  const selected = [...new Set(paths)];
  // Preserve inherited host PATH verbatim (including empty entries). Avoid
  // growing the prefix on resume/nested PPA launches using the same selection.
  const inherited = env["PATH"];
  const added = selected.join(":");
  const path = inherited === added || inherited?.startsWith(`${added}:`)
    ? inherited : `${added}${inherited === undefined ? "" : `:${inherited}`}`;
  return { ...env, PATH: path };
}

export interface ManagedAxiInvocation {
  tool: AxiTool;
  /** Fixed by the installed Nix shim, never resolved through npm/npx or PATH. */
  node: string;
  entrypoint: string;
  gh: string;
  /** Installed Nix shim supplies the fixed integrity-pinned MCP entrypoint. */
  mcp?: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}
export interface AxiPolicyEffects {
  ghAuthenticated: (executable: string, host: string, env: NodeJS.ProcessEnv) => boolean;
  chromeExecutable: (path: string) => boolean;
  run: (node: string, args: readonly string[], env: NodeJS.ProcessEnv) => number;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  browser?: (input: ManagedAxiInvocation) => { status: number; stdout: string };
  quota?: QuotaEffects;
}

function metadataRequest(args: readonly string[]): "help" | "version" | undefined {
  if (args.length !== 1) return undefined;
  if (["--help", "-h", "help"].includes(args[0]!)) return "help";
  if (["--version", "-v", "-V", "version"].includes(args[0]!)) return "version";
  return undefined;
}
function githubHost(args: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  let host = env["GH_HOST"] || "github.com";
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--hostname") {
      const value = args[++index];
      if (!value) return undefined;
      host = value;
    } else if (arg.startsWith("--hostname=")) host = arg.slice("--hostname=".length);
  }
  return /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host) ? host : undefined;
}

/** Managed admission precedes any operational filesystem/provider access.
 * Browser lifecycle and quota consent/output policy live in bounded modules. */
export function runManagedAxi(input: ManagedAxiInvocation, effects: AxiPolicyEffects = productionEffects): number {
  const deny = (code: AxiDiagnosticCode): number => { effects.stderr(axiDiagnostic(code)); return 1; };
  const metadata = metadataRequest(input.args);
  if (metadata === "version") { effects.stdout(`${input.tool} ${AXI_VERSIONS[input.tool]}\n`); return 0; }
  if (metadata === "help") {
    effects.stdout(`Usage: ${input.tool} [arguments]\nManaged PPA tool ${AXI_VERSIONS[input.tool]}. --help/--version need no authentication.\n${input.tool === "gh-axi" ? "GitHub operations require operator gh authentication and existing PA action approval; setup/hooks are denied.\n" : input.tool === "quota-axi" ? "Quota reads only: quota [--json]; explicit deployment-bound profile consent required.\n" : "Isolated headless browser: start, stop, pages, open, newpage, snapshot, click, fill, press, back, selectpage, closepage. Operator Chrome required; launch/attach/profile overrides denied.\n"}`);
    return 0;
  }
  if (!isAbsolute(input.node) || !isAbsolute(input.entrypoint)) return deny("AXI_POLICY_REJECTED");
  if (input.tool === "chrome-devtools-axi") {
    if (!browserArgumentsAllowed(input.args, input.env)) return deny("AXI_POLICY_REJECTED");
    const chrome = input.env["PA_AXI_CHROME_EXECUTABLE"];
    if (!chrome || !isAbsolute(chrome)) return deny("AXI_CHROME_REQUIRED");
    try { if (!effects.chromeExecutable(chrome)) return deny("AXI_CHROME_REQUIRED"); }
    catch { return deny("AXI_CHROME_REQUIRED"); }
    if (!input.mcp || !isAbsolute(input.mcp) || !effects.browser) return deny("AXI_POLICY_REJECTED");
    try {
      const result = effects.browser(input);
      if (result.status !== 0) return deny("AXI_POLICY_REJECTED");
      effects.stdout(result.stdout);
      return 0;
    } catch { return deny("AXI_POLICY_REJECTED"); }
  }
  if (input.tool === "quota-axi") {
    if (!quotaReadArguments(input.args) || !quotaEnvironmentAllowed(input.env)) return deny("AXI_POLICY_REJECTED");
    if (!input.env["PA_AXI_QUOTA_CONSENT"]) return deny("AXI_QUOTA_CONSENT_REQUIRED");
    try { effects.stdout(`${JSON.stringify({ providers: runManagedQuota(input, effects.quota) })}\n`); return 0; }
    catch { return deny("AXI_POLICY_REJECTED"); }
  }
  // The pinned upstream setup command installs global hooks/skills. Never
  // expose it through managed PPA, including mixed help/operational requests.
  const commands = ["issue", "pr", "stack", "run", "workflow", "release", "repo", "label", "gist", "project", "secret", "variable", "search", "api"];
  if (input.args.length && !commands.includes(input.args[0]!)) return deny("AXI_POLICY_REJECTED");
  const host = githubHost(input.args, input.env);
  if (!host || !isAbsolute(input.gh)) return deny("AXI_POLICY_REJECTED");
  const env = { ...input.env, GH_HOST: host, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  try { if (!effects.ghAuthenticated(input.gh, host, env)) return deny("AXI_GH_AUTH_REQUIRED"); }
  catch { return deny("AXI_GH_AUTH_REQUIRED"); }
  try { return effects.run(input.node, [input.entrypoint, ...input.args], env); }
  catch { return deny("AXI_POLICY_REJECTED"); }
}

const productionEffects: AxiPolicyEffects = {
  ghAuthenticated: (executable, host, env) => {
    // Capture and discard all identity/credential-bearing auth output. There
    // is no login, credential copying, interactive prompt or fallback install.
    const result = spawnSync(executable, ["auth", "status", "--active", "--hostname", host], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 64 * 1024,
    });
    return !result.error && result.status === 0;
  },
  browser: (input) => {
    const module = fileURLToPath(new URL("./axi-browser.js", import.meta.url));
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PA_DEPLOYMENT_ID", "PA_DEPLOYMENT_DIR", "PA_AXI_LIFECYCLE_PID", "PA_AXI_LIFECYCLE_START"]) env[key] = input.env[key];
    const result = spawnSync(input.node, [module, "command", input.node, input.entrypoint, input.mcp!, input.env["PA_AXI_CHROME_EXECUTABLE"]!, ...input.args], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 75000, killSignal: "SIGTERM", maxBuffer: 1024 * 1024,
    });
    return { status: result.error || result.signal ? 1 : result.status ?? 1, stdout: result.stdout || "" };
  },
  chromeExecutable: (path) => { accessSync(path, constants.X_OK); return statSync(path).isFile(); },
  run: (node, args, env) => {
    const result = spawnSync(node, [...args], { env, stdio: "inherit" });
    if (result.error || result.signal || result.status === null) throw new Error("managed AXI execution failed");
    return result.status;
  },
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
};

// Installed selected-tool shims pass four fixed positional values before user
// arguments. Importing the module (including adapter startup) performs no action.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tool, node, entrypoint, gh, mcp, ...args] = process.argv.slice(2);
  if (!tool || !Object.hasOwn(AXI_VERSIONS, tool) || !node || !entrypoint || !gh || !mcp) {
    process.stderr.write(axiDiagnostic("AXI_POLICY_REJECTED"));
    process.exitCode = 1;
  } else {
    process.exitCode = runManagedAxi({ tool: tool as AxiTool, node, entrypoint, gh, mcp, args, env: process.env });
  }
}
