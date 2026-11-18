import { MODE_CAPABILITY_MAX_BYTES, ModeCapabilityError, READONLY_DOCUMENT_PROFILE, modePublicName, modeResourcePath, parseReadonlyDocumentPolicy } from "./mode-capabilities.js";

const deny = (): never => { throw new ModeCapabilityError("CAPABILITY_POLICY_INVALID"); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return deny();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key) || !("value" in descriptors[key]!))) return deny();
  // The prototype, own descriptors and keys were checked above; values remain unknown.
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return deny();
  return value;
}
function list(value: unknown, visit: (value: unknown) => void): void {
  if (!Array.isArray(value) || value.length > 64) return deny();
  for (const entry of value) visit(entry);
}
function optionalList(value: unknown, visit: (value: unknown) => void): void { if (value !== undefined) list(value, visit); }
function optionalText(value: unknown): void { if (value !== undefined) text(value); }
function boolean(value: unknown): void { if (value !== undefined && typeof value !== "boolean") deny(); }
function timeout(value: unknown): void { if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) deny(); }

/** Strict opt-in configuration tree. No role, root, actor, grant or outcome fields.
 * Agents' role text is prompt content; the profile alone determines native semantics. */
export function validateReadonlyDocumentConfig(value: unknown): void {
  const team = object(value, ["name", "description", "objective", "agents", "default_mode", "deploy_modes", "global_docs", "variables", "context", "model", "timeout", "terse_mode"]);
  modePublicName(team.name); optionalText(team.description); optionalText(team.objective); optionalText(team.model); timeout(team.timeout); boolean(team.terse_mode);
  optionalList(team.global_docs, modeResourcePath);
  if (team.context !== undefined) { const context = object(team.context, ["organization", "notes"]); optionalText(context.organization); optionalText(context.notes); }
  if (team.variables !== undefined) {
    const variables = object(team.variables, Object.keys(team.variables ?? {}));
    if (Object.keys(variables).length > 64) deny();
    for (const [key, value] of Object.entries(variables)) { if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) deny(); text(value); }
  }
  const agents = new Set<string>();
  list(team.agents, value => {
    const agent = object(value, ["name", "role", "instruction", "skill", "model"]), name = modePublicName(agent.name);
    if (agents.has(name)) deny(); agents.add(name); text(agent.role); optionalText(agent.model);
    if (agent.instruction !== undefined) modeResourcePath(agent.instruction);
    if (agent.skill !== undefined) modeResourcePath(agent.skill);
  });
  const modes = new Set<string>();
  list(team.deploy_modes, value => {
    const mode = object(value, ["id", "label", "phone_visible", "objective", "agents", "skills", "mode_type", "solo", "model", "provider", "timeout", "global_docs", "project_guides", "require_ticket", "document_profile", "capability_policy"]);
    const id = modePublicName(mode.id); if (modes.has(id)) deny(); modes.add(id); text(mode.label);
    if (mode.document_profile !== READONLY_DOCUMENT_PROFILE) throw new ModeCapabilityError("CAPABILITY_PROFILE");
    parseReadonlyDocumentPolicy(mode.capability_policy); modeResourcePath(mode.objective);
    for (const key of ["phone_visible", "solo", "require_ticket"]) boolean(mode[key]);
    timeout(mode.timeout); optionalText(mode.model); optionalText(mode.provider);
    if (mode.mode_type !== undefined && (typeof mode.mode_type !== "string" || !["housekeeping", "work", "interactive"].includes(mode.mode_type))) deny();
    const selected = new Set<string>();
    optionalList(mode.agents, value => { const name = modePublicName(value); if (!agents.has(name) || selected.has(name)) deny(); selected.add(name); });
    const skills = new Set<string>();
    optionalList(mode.skills, value => {
      const skill = object(value, ["name", "inject-as"]), name = modeResourcePath(skill.name);
      if (skills.has(name) || typeof skill["inject-as"] !== "string" || !["global-skill", "shared-skill", "reference"].includes(skill["inject-as"])) deny(); skills.add(name);
    });
    optionalList(mode.global_docs, modeResourcePath);
    if (mode.project_guides !== undefined) {
      const guides = object(mode.project_guides, Object.keys(mode.project_guides ?? {}));
      if (Object.keys(guides).length > 64) deny();
      for (const [key, paths] of Object.entries(guides)) { if (!/^[a-z][a-z0-9._-]{0,127}$/.test(key)) deny(); list(paths, modeResourcePath); }
    }
  });
  if (!modes.size || team.default_mode !== undefined && !modes.has(modePublicName(team.default_mode))) deny();
  if (Buffer.byteLength(JSON.stringify(value)) > MODE_CAPABILITY_MAX_BYTES) deny();
}
