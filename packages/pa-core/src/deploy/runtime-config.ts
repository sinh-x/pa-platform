import type { DeployRequest } from "./control.js";
import type { DeployMode, RuntimeName, RuntimeOverrides, TeamConfig } from "../types.js";

export interface RuntimeConfigResolutionInput {
  runtime: RuntimeName;
  request: Pick<DeployRequest, "provider" | "model" | "teamModel">;
  team: TeamConfig;
  mode?: DeployMode;
  local?: RuntimeOverrides;
}

export function resolveRuntimeConfig(input: RuntimeConfigResolutionInput): RuntimeOverrides {
  const runtime = input.runtime;
  const mode = input.mode?.runtimes?.[runtime];
  const team = input.team.runtimes?.[runtime];
  const local = input.local;
  return {
    ...(input.request.provider ?? mode?.provider ?? team?.provider ?? local?.provider ? { provider: input.request.provider ?? mode?.provider ?? team?.provider ?? local?.provider } : {}),
    ...(input.request.model ?? input.request.teamModel ?? mode?.model ?? team?.model ?? local?.model ? { model: input.request.model ?? input.request.teamModel ?? mode?.model ?? team?.model ?? local?.model } : {}),
    ...(mode?.autonomy ?? team?.autonomy ?? local?.autonomy ? { autonomy: mode?.autonomy ?? team?.autonomy ?? local?.autonomy } : {}),
    ...(mode?.timeout ?? team?.timeout ?? local?.timeout ? { timeout: mode?.timeout ?? team?.timeout ?? local?.timeout } : {}),
  };
}
