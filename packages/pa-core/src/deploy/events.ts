import { appendRegistryEvent } from "../registry/index.js";
import { nowUtc } from "../time.js";
import type { Rating, RuntimeName } from "../types.js";

export interface StartDeploymentOpts {
  deploymentId: string;
  team: string;
  primer?: string;
  agents?: string[];
  models?: Record<string, string>;
  ticketId?: string;
  objective?: string;
  provider?: string;
  repo?: string;
  runtime?: RuntimeName;
  binary?: string;
  resumedFromDeploymentId?: string;
}

/**
 * Emit a "started" registry event for a deployment.
 */
export function emitStartedEvent(opts: StartDeploymentOpts): void {
  appendRegistryEvent({
    deployment_id: opts.deploymentId,
    team: opts.team,
    event: "started",
    timestamp: nowUtc(),
    primer: opts.primer,
    agents: opts.agents,
    models: opts.models,
    ticket_id: opts.ticketId,
    objective: opts.objective,
    provider: opts.provider,
    repo: opts.repo,
    runtime: opts.runtime,
    binary: opts.binary,
    resumed_from_deployment_id: opts.resumedFromDeploymentId,
  });
}

export interface PidEventOpts {
  deploymentId: string;
  team: string;
  pid: number;
}

/**
 * Emit a "pid" registry event recording the process ID.
 */
export function emitPidEvent(opts: PidEventOpts): void {
  appendRegistryEvent({
    deployment_id: opts.deploymentId,
    team: opts.team,
    event: "pid",
    timestamp: nowUtc(),
    pid: opts.pid,
  });
}

export interface CompletedEventOpts {
  deploymentId: string;
  team: string;
  status?: "success" | "partial" | "failed";
  summary?: string;
  logFile?: string;
  rating?: Rating;
  exitCode?: number;
  fallback?: boolean;
}

/**
 * Emit a "completed" registry event for a deployment.
 */
export function emitCompletedEvent(opts: CompletedEventOpts): void {
  appendRegistryEvent({
    deployment_id: opts.deploymentId,
    team: opts.team,
    event: "completed",
    timestamp: nowUtc(),
    status: opts.status,
    summary: opts.summary,
    log_file: opts.logFile,
    rating: opts.rating,
    exit_code: opts.exitCode,
    fallback: opts.fallback,
  });
}

export interface CrashedEventOpts {
  deploymentId: string;
  team: string;
  error?: string;
  exitCode?: number;
}

/**
 * Emit a "crashed" registry event for a deployment.
 */
export function emitCrashedEvent(opts: CrashedEventOpts): void {
  appendRegistryEvent({
    deployment_id: opts.deploymentId,
    team: opts.team,
    event: "crashed",
    timestamp: nowUtc(),
    error: opts.error,
    exit_code: opts.exitCode,
  });
}

export interface AmendedEventOpts {
  deploymentId: string;
  team: string;
  note?: string;
  status?: "success" | "partial" | "failed";
  summary?: string;
}

/**
 * Emit an "amended" registry event for post-completion updates.
 */
export function emitAmendedEvent(opts: AmendedEventOpts): void {
  appendRegistryEvent({
    deployment_id: opts.deploymentId,
    team: opts.team,
    event: "amended",
    timestamp: nowUtc(),
    note: opts.note,
    status: opts.status,
    summary: opts.summary,
  });
}
