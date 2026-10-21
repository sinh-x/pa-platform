#!/usr/bin/env node
// Generic current-tree audit. Policy terms are supplied by the caller, never
// embedded as a runtime allowlist. Gitlinks are reported, not traversed.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function auditRuntimeReferences(root, terms) {
  if (!Array.isArray(terms) || !terms.length || terms.some(term => typeof term !== 'string' || !/^[a-z0-9@][a-z0-9@/._ -]*$/i.test(term))) {
    throw new Error('provide a nonempty --forbidden comma-separated token/package list');
  }
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
  const records = git(['ls-files', '--stage', '-z']);
  // Also inspect newly added work before commit; clean candidate verification
  // still uses the same tracked inventory and cannot hide untracked source.
  for (const path of git(['ls-files', '--others', '--exclude-standard', '-z'])) records.push(`100644 ${'0'.repeat(40)} 0\t${path}`);
  const deleted = new Set(git(['ls-files', '--deleted', '-z']));
  const patterns = [...new Set(terms)].map(term => ({ term, re: new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`, 'ig') }));
  const findings = [];
  const exclusions = [];
  let files = 0, binaries = 0, deletedFiles = 0;
  const paths = new Set();
  const inspect = (path, text, kind) => {
    for (const { term, re } of patterns) {
      re.lastIndex = 0;
      for (const match of text.matchAll(re)) findings.push({ path, kind, term, line: kind === 'path' ? undefined : text.slice(0, match.index).split('\n').length });
    }
  };
  for (const record of records) {
    const parsed = /^(\d+) [0-9a-f]+ (\d)\t([\s\S]+)$/.exec(record);
    if (!parsed || parsed[2] !== '0') throw new Error('unreadable or unmerged Git index entry');
    const [, mode, , path] = parsed;
    if (paths.has(path)) throw new Error(`duplicate Git path: ${JSON.stringify(path)}`);
    paths.add(path);
    if (mode === '160000') {
      inspect(path, path, 'path');
      exclusions.push({ path, reason: 'pinned vendor Gitlink; no traversal (vendor acronyms are not PA runtime adapters)' });
      continue;
    }
    if (deleted.has(path)) { deletedFiles++; continue; }
    inspect(path, path, 'path');
    const absolute = resolve(root, path);
    const stat = lstatSync(absolute); // Unreadable paths fail closed.
    const body = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    files++;
    if (body.includes(0)) { binaries++; continue; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    inspect(path, text, 'text');
    // Reject broken local document links independent of the supplied policy.
    if (path.endsWith('.md')) for (const match of text.matchAll(/\]\(([^\s)#]+\.md)(?:#[^\s)]*)?\)/g)) {
      const target = match[1];
      if (/^(?:[a-z]+:|\/)/i.test(target)) continue;
      const relative = resolve(absolute, '..', decodeURIComponent(target)).slice(resolve(root).length + 1);
      if (!paths.has(relative) && !records.some(record => record.endsWith(`\t${relative}`))) findings.push({ path, kind: 'dead-document-link', target });
      else if (deleted.has(relative)) findings.push({ path, kind: 'dead-document-link', target });
    }
  }
  return { files, binaries, deletedFiles, gitlinks: exclusions.length, matches: findings.length, exclusions, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--forbidden') throw new Error('usage: check_runtime_retirement.mjs --forbidden token,package,...');
    const report = auditRuntimeReferences(process.cwd(), process.argv[3].split(','));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.matches ? 1 : 0;
  } catch (error) {
    process.stderr.write(`runtime-reference audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
