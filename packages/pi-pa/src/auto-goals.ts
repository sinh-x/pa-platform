import { resolve } from "node:path";
import { AutoWaitlistError, assertLocalFileSource, assertNoSensitiveMatch, checkSourceContent, getAiUsageDir, readArtifactFile, workflowDigest } from "@pa-platform/pa-core";
import type { PiAutoShortlistPair } from "./auto-shortlist-contract.js";

/** Relevant configured goal sections only. Whole files pass the existing local
 * source policy before projection; a denial never triggers an alternate read.
 * No reflection, priority list or historical suggestion is invented as a goal. */
export function readAutoGoalEvidence(pair: PiAutoShortlistPair, now = new Date(), root = getAiUsageDir()): Buffer {
  try {
    pair.assertCurrent();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: pair.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (name: string) => parts.find(p => p.type === name)?.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error();
    const sources = pair.goalSources.map(source => {
      const ref = source.pathTemplate.replace("{date}", source.dateFormat === "underscore" ? date.replaceAll("-", "_") : date);
      const path = resolve(root, ref); assertLocalFileSource(path);
      const bytes = readArtifactFile(path, 131_072, "ARTIFACT_STALE");
      const body = checkSourceContent({ source: { kind: "local-file", path }, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }).content;
      const lines = body.split(/\r?\n/), matches = lines.map((line, i) => ({ i, match: /^(#{1,6}) (.+?)\s*$/.exec(line) })).filter(row => row.match?.[2] === source.heading);
      if (matches.length !== 1) throw new Error();
      const { i, match } = matches[0]!, level = match![1]!.length;
      let end = i + 1;
      while (end < lines.length) { const next = /^(#{1,6}) /.exec(lines[end]!); if (next && next[1]!.length <= level) break; end++; }
      const excerpt = lines.slice(i + 1, end).join("\n").trim();
      if (!excerpt || Buffer.byteLength(excerpt) > 16_384) throw new Error();
      assertNoSensitiveMatch("content", excerpt);
      return { ref, date, heading: source.heading, sourceSha256: workflowDigest(bytes), excerptSha256: workflowDigest(excerpt), excerpt };
    });
    const result = Buffer.from(JSON.stringify({ schemaVersion: "pa-auto-goal-evidence/v1", date, timezone: pair.timezone, sources }));
    if (result.length > 65_536) throw new Error();
    assertNoSensitiveMatch("content", result.toString("utf8")); pair.assertCurrent(); return result;
  } catch { throw new AutoWaitlistError("AUTO_SOURCE"); }
}
