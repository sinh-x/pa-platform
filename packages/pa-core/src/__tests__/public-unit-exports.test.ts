import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../index.js";
import * as activity from "../activity/index.js";
import * as codectx from "../codectx/index.js";
import * as documents from "../documents/index.js";
import * as health from "../health/index.js";
import * as knowledge from "../knowledge/index.js";
import * as paths from "../paths.js";
import * as registry from "../registry/index.js";
import * as repoHealth from "../repo-health/index.js";
import * as signal from "../signal/index.js";
import * as safety from "../safety-policy.js";
import * as skills from "../skills/index.js";
import * as teams from "../teams/index.js";
import * as tickets from "../tickets/store.js";
import * as yaml from "../yaml-parser.js";

// Load the public barrel once for export wiring, not once per utility suite.
// Functional cases still exercise these identical production implementations.
const unitExportGroups = [
  [activity, "appendActivityEvent createActivityEvent getActivityLogPath readActivityEvents readDeploymentActivity summarizeActivity writeActivityEvents"],
  [codectx, "analyzeRepo deleteGraph formatExportsResult generateMarkdown generateSummary graphExists loadGraph queryClass queryExports queryFile queryFunction saveGraph"],
  [documents, "aiUsageRelativePath documentPath getImageContentType insertDocumentSection listDocuments listMarkdownFiles readDocument readMarkdownDocument writeDocument"],
  [health, "checkAgents checkDeployments checkTickets detectErrorLoops formatPrimerHealthSummary generateHealthReport listHealthSnapshots parseActivityLog saveHealthSnapshot"],
  [knowledge, "listImprovementCandidates listKnowledgeBoundaries"],
  [paths, "getPlatformHomeDir getRepoHealthDbPath getRepoHealthDir"],
  [registry, "appendEvaluatorResult appendRegistryEvent closeDb"],
  [repoHealth, "getRepoHealthDb insertRepoHealthReport getLatestRepoHealthReport getLatestRepoHealthReportWithBranches listRepoHealthReports rowToRepoHealthReport"],
  [signal, "cleanSignalEntries getSignalPaths isSensitive markSignalNoteAsProcessed parseSignalNoteMarkdown parseSqlcipherRows readCollectorState routeRawSignalNote saveRawNote writeCollectorState writeRoutedMessage"],
  [safety, "classifyOutputTarget classifyPathOperand classifyShellCommand evaluateSafetyPolicy formatTrashMoveGuidance isBlockedFilePath isDestructiveCommand"],
  [skills, "buildSkillRegistryReport"],
  [teams, "getTeamModel listAgentTeamWorkspaces listTeamConfigs loadTeamConfig validateTeamSkillReferences"],
  [tickets, "TicketStore"],
  [yaml, "parseTeamYamlContent"],
] as const;

test("public utility exports retain the exact implementations exercised by focused unit suites", () => {
  const seen = new Set<string>();
  for (const [owner, names] of unitExportGroups) for (const name of names.split(" ")) {
    assert.equal(seen.has(name), false, `duplicate export coverage: ${name}`);
    seen.add(name);
    assert.equal(Object.hasOwn(owner, name), true, `missing implementation: ${name}`);
    assert.equal(Object.hasOwn(api, name), true, `missing public export: ${name}`);
    assert.equal(api[name as keyof typeof api], (owner as Record<string, unknown>)[name], `miswired public export: ${name}`);
  }
});
