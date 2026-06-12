export type BuilderCompletionPath = "builder-implement" | "builder-orchestrator";

export function resolveBuilderCompletionPath(team: string, mode?: string): BuilderCompletionPath | null {
  if (team !== "builder") return null;
  if (mode === "implement") return "builder-implement";
  if (mode === "orchestrator") return "builder-orchestrator";
  return null;
}

export function extractEvaluatorDeploymentId(output: string): string | undefined {
  const match = output.match(/Evaluation\s+(?:pending|completed):\s+(d-[a-z0-9]{6})/);
  return match?.[1];
}

export function compactReason(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "unknown";
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 239)}...`;
}

export function isAutoLaunchEnabled(enabled: boolean | undefined): boolean {
  return enabled === true;
}
