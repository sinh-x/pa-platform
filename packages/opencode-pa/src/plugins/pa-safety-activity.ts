import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PA_SAFETY_ACTIVITY_PLUGIN_FILENAME = "pa-safety-activity.js";

const PA_CORE_SAFETY_MODULE_URL = new URL("./safety-policy.js", import.meta.resolve("@pa-platform/pa-core")).href;

export const PA_SAFETY_ACTIVITY_PLUGIN_SOURCE = String.raw`import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import * as paSafety from ${JSON.stringify(PA_CORE_SAFETY_MODULE_URL)}

function deploymentId() {
  return process.env.PA_DEPLOYMENT_ID || "unknown"
}

function isPaDeployment() {
  return Boolean(process.env.PA_ACTIVITY_LOG || process.env.PA_DEPLOYMENT_DIR)
}

function activityLogPath() {
  if (process.env.PA_ACTIVITY_LOG) return process.env.PA_ACTIVITY_LOG
  if (process.env.PA_DEPLOYMENT_DIR) return join(process.env.PA_DEPLOYMENT_DIR, "activity.jsonl")
  return ""
}

function patternsFile() {
  return join(process.env.HOME || "", ".claude", "hooks", "sensitive-patterns.conf")
}

function readPatterns() {
  const path = patternsFile()
  if (!path || !existsSync(path)) return []

  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("|")
      return separator === -1 ? null : { label: line.slice(0, separator), pattern: line.slice(separator + 1) }
    })
    .filter(Boolean)
}

const PATTERNS = readPatterns()
let lastActivityKey = ""
let lastActivityAt = 0

function truncate(value, max = 400) {
  if (value === undefined || value === null) return ""
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > max ? text.slice(0, max) : text
}

function nowUtc(date = new Date()) {
  return date.toISOString()
}

function appendActivity(event) {
  if (!isPaDeployment()) return
  const path = activityLogPath()
  if (!path) return
  const now = Date.now()
  const dedupeKey = event.event + ":" + JSON.stringify(event.data || {})
  if (dedupeKey === lastActivityKey && now - lastActivityAt < 1000) return
  lastActivityKey = dedupeKey
  lastActivityAt = now
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify({ ts: nowUtc(), deploy_id: deploymentId(), ...event }) + "\n")
}

function sessionId(input) {
  return truncate(input?.sessionID || input?.sessionId || input?.session?.id || "", 8)
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^\${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp("^" + escaped + "$")
}

function isBlockedFilePath(filePath) {
  if (!filePath) return false
  const expanded = filePath.replace(/^~/, process.env.HOME || "")
  const name = basename(expanded)

  for (const { label, pattern } of PATTERNS) {
    if (label !== "FILE") continue
    const regex = globToRegex(pattern)
    if (regex.test(name) || regex.test(expanded)) return true
  }

  return [
    /(^|\/)\.env(\.|$)/,
    /(^|\/)\.ssh\/id_/,
    /credentials/i,
    /secrets?.*\.(json|ya?ml)$/i,
    /[-_]token\.json$/i,
    /[-_]api[-_]?key\.json$/i,
    /(^|\/)\.netrc$/,
    /(^|\/)\.npmrc$/,
    /(^|\/)\.pypirc$/,
  ].some((regex) => regex.test(expanded))
}

function toJavaScriptRegex(pattern) {
  return pattern.replaceAll("[[:space:]]", "\\s")
}

function maskSensitiveText(text) {
  let result = text
  for (const { label, pattern } of PATTERNS) {
    if (label === "FILE" || label.startsWith("JSON_")) continue
    try {
      result = result.replace(new RegExp(toJavaScriptRegex(pattern), "g"), "***" + label + "_MASKED***")
    } catch {}
  }
  return result
}

function commandReferencesBlockedFile(command) {
  return command
    .replace(/[|;&()]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter((token) => token && !token.startsWith("-") && !token.includes("=") && !token.includes(" "))
    .find((token) => isBlockedFilePath(token))
}

function trashGuidance(target, executable) {
  if (typeof paSafety.formatTrashMoveGuidance === "function") return paSafety.formatTrashMoveGuidance(target, executable)
  return executable + " trash move " + target + " --reason 'Replace direct deletion denied by PA safety policy' --yes"
}

function legacySafetyDecision(input, executable) {
  if (input.kind === "prose") return { allowed: true }
  if (input.kind === "path") return isBlockedFilePath(input.value)
    ? { allowed: false, reason: "Protected path access is not allowed: " + input.value, target: input.value }
    : { allowed: true }
  const command = input.value || ""
  const deletion = /(?:^|[\s;&|()])(?:command\s+|sudo\s+)*(?:rm|rmdir|unlink|shred)\b(?:\s+-[^\s]+)*\s+("[^"]+"|'[^']+'|[^\s;&|()<>]+)/i.exec(command)
  if (deletion) {
    const target = deletion[1] || "<target>"
    return { allowed: false, reason: "Direct deletion is not allowed for target " + target, target, guidance: trashGuidance(target, executable) }
  }
  if (/(^|\||;|&&|\|\|)\s*(?:find\s+[^|;]*-delete|xargs\s+[^|;]*\brm)\b/.test(command)) {
    return { allowed: false, reason: "Direct deletion is not allowed for target <target>", target: "<target>", guidance: trashGuidance("<target>", executable) }
  }
  const redirects = /(?:^|[^>])(?:\d*)>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|()]+)/g
  for (const match of command.matchAll(redirects)) {
    const target = (match[1] || "").replace(/^['"]|['"]$/g, "")
    if (target === "/dev/null" || target.startsWith("/tmp/") || target.startsWith("$TMPDIR/")) continue
    return { allowed: false, reason: "Output is allowed only for /dev/null or a verified system-temp target: " + target, target }
  }
  const blockedPath = commandReferencesBlockedFile(command)
  return blockedPath
    ? { allowed: false, reason: "Protected path access is not allowed: " + blockedPath, target: blockedPath }
    : { allowed: true }
}

function evaluatePolicy(input, executable = "opa") {
  return typeof paSafety.evaluateSafetyPolicy === "function"
    ? paSafety.evaluateSafetyPolicy(input, { trashExecutable: executable })
    : legacySafetyDecision(input, executable)
}

function denyMessage(decision) {
  return "BLOCKED: " + (decision.reason || "PA safety policy denied this operation.")
    + (decision.guidance ? " Use " + decision.guidance + "." : "")
}

function guardBash(command) {
  if (!command) return
  const decision = evaluatePolicy({ kind: "shell", value: command })
  if (!decision.allowed) throw new Error(denyMessage(decision))
}

function guardPath(filePath) {
  if (!filePath) return
  const decision = evaluatePolicy({ kind: "path", value: filePath })
  if (!decision.allowed) throw new Error(denyMessage(decision))
}

function patchText(args) {
  return args?.patchText || args?.patch || ""
}

function pathsFromPatch(patch) {
  const paths = []
  for (const line of patch.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^\*\*\* Move to: (.+)$/)
    if (match) paths.push(match[1].trim())
  }
  return paths
}

function guardPatch(args) {
  const patch = patchText(args)
  if (!patch) return
  const deletedPath = patch.split("\n").map((line) => line.match(/^\*\*\* Delete File: (.+)$/)?.[1]?.trim()).find(Boolean)
  if (deletedPath) throw new Error(denyMessage({
    reason: "Direct deletion is not allowed for target " + deletedPath,
    guidance: trashGuidance(deletedPath, "opa"),
  }))
  for (const filePath of pathsFromPatch(patch)) guardPath(filePath)
}

function summarizeTool(tool, args) {
  if (!args) return ""
  switch (tool) {
    case "bash": return truncate(args.command)
    case "read":
    case "write":
    case "edit": return truncate(args.filePath || args.file_path)
    case "grep": return truncate((args.pattern || "") + " -> " + (args.path || "."))
    case "glob": return truncate(args.pattern)
    case "webfetch": return truncate(args.url, 150)
    default: return truncate(args)
  }
}

function summarizeResult(result) {
  if (!result) return ""
  if (typeof result === "string") return truncate(maskSensitiveText(result))
  if (result.error) return truncate(maskSensitiveText(result.error))
  if (result.exitCode !== undefined) return "exit_code=" + result.exitCode
  if (result.exit_code !== undefined) return "exit_code=" + result.exit_code
  if (result.metadata?.exitCode !== undefined) return "exit_code=" + result.metadata.exitCode
  return truncate(maskSensitiveText(JSON.stringify(result)))
}

function summarizeBody(properties) {
  if (!properties) return ""
  return truncate(maskSensitiveText(String(properties.summary || properties.message || properties.text || properties.content || properties.title || properties.error || properties.status || "")), 500)
}

function messagePart(properties) {
  return properties?.part || properties?.message?.part || properties?.chunk || properties
}

function messageText(part) {
  return part?.text || part?.content || part?.delta || part?.thinking || part?.message || ""
}

function messagePartType(part, properties) {
  return part?.type || properties?.partType || properties?.type || "text"
}

export const PaSafetyActivityPlugin = async () => {
  const path = activityLogPath()

  if (isPaDeployment() && process.env.PA_DEPLOYMENT_DIR) {
    mkdirSync(process.env.PA_DEPLOYMENT_DIR, { recursive: true })
    writeFileSync(join(process.env.PA_DEPLOYMENT_DIR, "opencode-activity-log-path.txt"), path + "\n")
  }

  appendActivity({ agent: "main", event: "session_started", data: { log_path: path, client: "opencode" } })

  return {
    "shell.env": async (_input, output) => {
      if (path) output.env.PA_ACTIVITY_LOG = path
    },

    "tool.execute.before": async (input, output) => {
      const tool = input?.tool || output?.tool || "unknown"
      const args = output?.args || input?.args || {}
      const activityArgs = { ...args }
      if (isPaDeployment()) {
        if (tool === "bash") {
          guardBash(args.command || "")
          if (typeof activityArgs.command === "string") activityArgs.command = maskSensitiveText(activityArgs.command)
        }
        if (["read", "write", "edit", "grep", "glob"].includes(tool)) {
          guardPath(args.filePath || args.file_path || args.path)
        }
        if (tool === "apply_patch") guardPatch(args)
      }
      appendActivity({ agent: sessionId(input), event: "tool.execute.before", data: { tool, args: activityArgs, summary: summarizeTool(tool, activityArgs) } })
    },

    "tool.execute.after": async (input, output) => {
      const tool = input?.tool || output?.tool || "unknown"
      appendActivity({ agent: sessionId(input), event: "tool.execute.after", data: { tool, tool_use_id: input?.toolCallID || input?.toolCallId || input?.id || "", error: output?.error || undefined, result: output?.result, summary: summarizeResult(output?.result || output) } })
    },

    event: async ({ event }) => {
      const properties = event?.properties || {}
      switch (event?.type) {
        case "message.part.updated":
        case "message.updated": {
          const part = messagePart(properties)
          const partType = messagePartType(part, properties)
          appendActivity({ agent: sessionId(properties), event: event.type, data: { ...properties, part_type: partType, text: truncate(maskSensitiveText(String(messageText(part))), 1000) } })
          break
        }
        case "message.part.removed":
        case "message.removed":
        case "session.created":
        case "session.updated":
        case "session.status":
        case "session.idle":
        case "session.compacted":
        case "session.diff":
        case "session.deleted":
        case "session.error":
        case "permission.asked":
        case "permission.replied":
        case "todo.updated":
        case "command.executed":
        case "file.edited":
        case "file.watcher.updated":
        case "lsp.client.diagnostics":
        case "lsp.updated":
        case "installation.updated":
        case "server.connected":
        case "tui.prompt.append":
        case "tui.command.execute":
        case "tui.toast.show":
          appendActivity({ agent: sessionId(properties) || "main", event: event.type, data: { ...properties, summary: summarizeBody(properties) } })
          break
      }
    },
  }
}
`;

export function resolvePaSafetyActivityPluginPath(env: NodeJS.ProcessEnv = process.env): string {
  const opencodeConfigDir = env["OPENCODE_CONFIG_DIR"]
    ?? (env["XDG_CONFIG_HOME"] ? join(env["XDG_CONFIG_HOME"], "opencode") : join(env["HOME"] ?? homedir(), ".config", "opencode"));
  return join(opencodeConfigDir, "plugins", PA_SAFETY_ACTIVITY_PLUGIN_FILENAME);
}

export function installPaSafetyActivityPlugin(env: NodeJS.ProcessEnv = process.env): string {
  const pluginPath = resolvePaSafetyActivityPluginPath(env);
  mkdirSync(dirname(pluginPath), { recursive: true });
  writeFileSync(pluginPath, PA_SAFETY_ACTIVITY_PLUGIN_SOURCE, "utf-8");
  return pluginPath;
}
