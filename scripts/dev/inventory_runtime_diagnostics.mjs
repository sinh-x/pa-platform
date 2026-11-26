#!/usr/bin/env node
// Conservative discovery only: neither reachability nor message compliance is inferred.
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function inventory(root) {
  const sites = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', 'vendor', '__tests__', 'public-web'].includes(entry.name)) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.(?:[cm]?[jt]s)$/.test(entry.name) || /(?:\.test|\.d)\.ts$/.test(entry.name)) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        let kind;
        if (ts.isThrowStatement(node)) kind = 'throw';
        else if (ts.isCatchClause(node)) kind = 'catch-propagation';
        else if (ts.isClassDeclaration(node) && node.heritageClauses?.some(c => c.types.some(t => t.expression.getText(source) === 'Error'))) kind = 'error-owner';
        else if (ts.isCallExpression(node)) {
          const name = node.expression.getText(source);
          if (/(?:^|\.)(?:warn|error|reject|fail|statusFail|ticketAdminFail|printError|workflowError)$/.test(name) || /(?:Fail|Error)$/.test(name)) kind = 'diagnostic-call';
          else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'stderr') kind = 'stderr';
        }
        if (kind) {
          const file = relative(root, path).split('\\').join('/');
          const parts = file.split('/');
          sites.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind,
            owner: parts[1] + '/' + (parts[3] ?? 'root'), disposition: 'needs-semantic-review' });
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  walk(resolve(root, 'packages'));
  return { schemaVersion: 'pa-runtime-diagnostic-inventory/v1', qualification: 'candidate-sites-only',
    exclusions: ['tests', 'vendor (upstream-owned)', 'generated outputs', 'public-web (separate UI)'], sites };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  process.stdout.write(JSON.stringify(inventory(root), null, 2) + '\n');
}
