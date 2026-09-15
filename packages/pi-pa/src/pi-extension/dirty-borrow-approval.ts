import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import {
  MAX_REPOSITORY_DIRTY_APPROVAL_BYTES,
  PA_PI_EXECUTION_MODE_ENV,
  captureRepositoryGitSnapshot,
  inspectRepositoryMutationLease,
  publishRepositoryDirtyBorrowApproval,
  queryDeploymentStatus,
  readProcessFingerprint,
  removeRepositoryDirtyBorrowApproval,
  repositoryDirtyBorrowApprovalPath,
  validateRepositoryDirtyBorrowScope,
  type RepositoryDirtyBorrowApproval,
  type RepositoryDirtyBorrowClassification,
  type RepositoryGitSnapshot,
  type RepositoryEvidenceInspection,
} from "@pa-platform/pa-core";
import type { PiExtensionModule, PiToolDefinition, PiToolResult } from "./index.js";

export interface DirtyBorrowApprovalInput extends Record<string, unknown> {
  classifications: RepositoryDirtyBorrowClassification[];
  plannedNewPaths: string[];
}

export interface DirtyBorrowApprovalDetails extends Record<string, unknown> {
  outcome: "approved" | "rejected" | "cancelled" | "ui_unavailable" | "validation_error";
  approvedPaths: string[];
  recordCount: number;
  error?: string;
}

interface ApprovalContext {
  mode: "tui" | "rpc" | "json" | "print";
  ui: { select(title: string, options: string[]): Promise<string | undefined> };
}

export interface DirtyBorrowApprovalToolOptions {
  env?: NodeJS.ProcessEnv;
  captureSnapshot?: (root: string) => RepositoryGitSnapshot;
  inspectLease?: (root: string, worktreeRoot?: string) => RepositoryEvidenceInspection;
  isDeploymentRunning?: (deploymentId: string) => boolean;
  now?: () => Date;
  createToken?: () => string;
  publishApproval?: (approval: RepositoryDirtyBorrowApproval) => string;
}

const ClassificationSchema = Type.Object({
  path: Type.String({ description: "Exact current repository-relative status-record path" }),
  classification: Type.String({ description: "active-ticket-produced or active-ticket-preserved" }),
});

export const DirtyBorrowApprovalParams = Type.Object({
  classifications: Type.Array(ClassificationSchema, { description: "Exactly one active-ticket lineage classification for every current status record" }),
  plannedNewPaths: Type.Array(Type.String(), { description: "Exact repository-relative new paths planned for the direct child; no globs or implicit directories" }),
});

export function isForegroundPiOrchestratorEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PA_PI_EXECUTION_MODE_ENV] === "foreground"
    && env["PA_TEAM"] === "builder"
    && env["PA_MODE"] === "orchestrator"
    && Boolean(env["PA_DEPLOYMENT_ID"])
    && Boolean(env["PA_DEPLOYMENT_DIR"])
    && Boolean(env["PA_REPO"])
    && Boolean(env["PA_TICKET_ID"]);
}

export function createDirtyBorrowApprovalTool(options: DirtyBorrowApprovalToolOptions = {}): PiToolDefinition<DirtyBorrowApprovalInput, DirtyBorrowApprovalDetails> {
  const env = options.env ?? process.env;
  const captureSnapshot = options.captureSnapshot ?? captureRepositoryGitSnapshot;
  const inspectLease = options.inspectLease ?? ((root: string, worktreeRoot?: string) => inspectRepositoryMutationLease(root, { getProcessFingerprint: readProcessFingerprint, worktreeRoot }));
  const isDeploymentRunning = options.isDeploymentRunning ?? ((deploymentId: string) => queryDeploymentStatus(deploymentId)?.status === "running");
  const now = options.now ?? (() => new Date());
  const createToken = options.createToken ?? randomUUID;
  const publishApproval = options.publishApproval ?? publishRepositoryDirtyBorrowApproval;
  return {
    name: "pa_dirty_borrow_approval",
    label: "PA Dirty Borrow Approval",
    description: "Ask Sinh to approve one complete classified dirty Git snapshot for exactly one direct background Pi builder/implement child.",
    promptSnippet: "Request explicit Sinh approval for one fully classified dirty direct-child continuation",
    promptGuidelines: [
      "Use pa_dirty_borrow_approval only after classifying every current dirty status record and listing every exact planned new path; cancellation or drift requires a fresh call.",
    ],
    executionMode: "sequential",
    parameters: DirtyBorrowApprovalParams,
    execute: async (toolCallId, input, signal, _onUpdate, rawContext) => {
      const context = rawContext as ApprovalContext;
      if (!isForegroundPiOrchestratorEnvironment(env) || context.mode !== "tui") return result("ui_unavailable", [], 0, "interactive foreground Pi builder/orchestrator UI is required");
      if (signal?.aborted) return result("cancelled", [], 0);
      try {
        const parentDeploymentId = requiredEnv(env, "PA_DEPLOYMENT_ID");
        const parentDeploymentDirectory = requiredEnv(env, "PA_DEPLOYMENT_DIR");
        const canonicalRepoRoot = requiredEnv(env, "PA_REPO");
        const worktreeRoot = env["PA_WORKTREE_ROOT"]?.trim() || canonicalRepoRoot;
        const ticket = requiredEnv(env, "PA_TICKET_ID");
        const leaseInspection = inspectLease(canonicalRepoRoot, worktreeRoot);
        const lease = leaseInspection.lease;
        if (leaseInspection.state !== "live" || !lease || !leaseInspection.evidenceIdentity
          || lease.deploymentId !== parentDeploymentId
          || lease.deploymentDirectory !== parentDeploymentDirectory
          || lease.canonicalRepoRoot !== canonicalRepoRoot
          || (lease.worktreeRoot ?? canonicalRepoRoot) !== worktreeRoot
          || lease.runtime !== "pi"
          || lease.team !== "builder"
          || lease.mode !== "orchestrator"
          || lease.launchMode !== "foreground"
          || !isDeploymentRunning(parentDeploymentId)) {
          return result("validation_error", [], 0, "parent owner is not exact, process-verified, and registry-running");
        }
        const snapshot = captureSnapshot(worktreeRoot);
        const approvedPaths = [...validateRepositoryDirtyBorrowScope(worktreeRoot, snapshot, input.classifications, input.plannedNewPaths)];
        const classificationByPath = new Map(input.classifications.map((item) => [item.path, item.classification]));
        const lines = snapshot.statusEntries!.map((entry) => `${entry.recordIndex}. ${entry.xy} ${JSON.stringify(entry.path)}${entry.sourcePath ? ` <- ${JSON.stringify(entry.sourcePath)}` : ""} — ${classificationByPath.get(entry.path)}`);
        const action = [
          "Approve preserve-and-continue for this complete classified snapshot?",
          `Branch: ${snapshot.branch}`,
          `HEAD: ${snapshot.head}`,
          ...lines,
          ...(input.plannedNewPaths.length > 0 ? ["Planned new paths:", ...input.plannedNewPaths.map((path) => `+ ${JSON.stringify(path)}`)] : ["Planned new paths: none"]),
        ].join("\n");
        const choice = await context.ui.select(action, ["Approve preserve-and-continue", "Reject and create no receipt"]);
        if (signal?.aborted || choice === undefined) return result("cancelled", [], snapshot.statusRecordCount ?? 0);
        if (choice !== "Approve preserve-and-continue") return result("rejected", [], snapshot.statusRecordCount ?? 0);
        const approval: RepositoryDirtyBorrowApproval = Object.freeze({
          schemaVersion: 1,
          receiptId: createToken(),
          approvalReference: toolCallId,
          approvedAt: now().toISOString(),
          action: "preserve-and-continue",
          parentDeploymentId,
          parentDeploymentDirectory,
          parentProcessFingerprint: lease.processFingerprint,
          parentLeaseEvidenceIdentity: leaseInspection.evidenceIdentity,
          canonicalRepoKey: lease.canonicalRepoKey,
          canonicalRepoRoot,
          ...(worktreeRoot !== canonicalRepoRoot ? { worktreeRoot } : {}),
          ticket,
          branch: snapshot.branch,
          snapshot,
          classifications: Object.freeze(input.classifications.map((item) => Object.freeze({ ...item }))),
          plannedNewPaths: Object.freeze([...input.plannedNewPaths]),
        });
        publishApproval(approval);
        return result("approved", approvedPaths, snapshot.statusRecordCount ?? 0);
      } catch (error) {
        return result("validation_error", [], 0, safeError(error));
      }
    },
  };
}

export const registerDirtyBorrowApprovalModule: PiExtensionModule = (pi, lifecycle) => {
  if (!isForegroundPiOrchestratorEnvironment()) return;
  const tool = createDirtyBorrowApprovalTool();
  pi.registerTool?.(tool);
  const root = process.env["PA_REPO"]!;
  const worktreeRoot = process.env["PA_WORKTREE_ROOT"]?.trim() || root;
  const approvalPath = repositoryDirtyBorrowApprovalPath(process.env["PA_DEPLOYMENT_DIR"]!);
  lifecycle?.addShutdownStep(() => {
    try {
      const stat = lstatSync(approvalPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_REPOSITORY_DIRTY_APPROVAL_BYTES) return;
      const body = JSON.parse(readFileSync(approvalPath, "utf8")) as { receiptId?: unknown };
      if (typeof body.receiptId === "string") removeRepositoryDirtyBorrowApproval({ canonicalRepoRoot: root, worktreeRoot, approvalPath, receiptId: body.receiptId });
    } catch {
      // Missing, consumed, or malformed evidence is left to admission's exact cleanup rules.
    }
  });
};

function result(outcome: DirtyBorrowApprovalDetails["outcome"], approvedPaths: string[], recordCount: number, error?: string): PiToolResult<DirtyBorrowApprovalDetails> {
  const text = outcome === "approved"
    ? `Sinh approved preserve-and-continue for ${recordCount} classified record(s) and ${approvedPaths.length} exact path(s).`
    : `Dirty borrower approval ${outcome.replaceAll("_", " ")}; no approval authority was created.`;
  return { content: [{ type: "text", text }], details: { outcome, approvedPaths, recordCount, ...(error ? { error } : {}) } };
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`dirty-borrow-approval: ${key} is required`);
  return value;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}
