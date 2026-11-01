#!/usr/bin/env node
// CI entry point: universal registry checks + diff-scope for sync PRs (ADR-024).
//
//   node scripts/ci/check.mjs --base <base registry.yaml> [--head registry.yaml]
//        [--changed-files <file with one path per line>] [--all-pins]
//
// Sync-PR detection reads HEAD_REF, PR_AUTHOR and SYNC_APP_LOGIN from the environment (never from
// an interpolated workflow expression). A sync PR also gets the diff-scope rules.
import fs from 'node:fs';
import yaml from '../lib/yaml.mjs';
import { isSyncPr, universalChecks, diffScope } from '../lib/checks.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const load = p => yaml.load(fs.readFileSync(p, 'utf8'))?.mcps ?? [];

const basePath = arg('--base');
const headPath = arg('--head') ?? 'registry.yaml';
const changedPath = arg('--changed-files');
const allPins = process.argv.includes('--all-pins');
if (!basePath) {
  console.error('usage: check.mjs --base <file> [--head <file>] [--changed-files <file>] [--all-pins]');
  process.exit(2);
}

const baseMcps = fs.existsSync(basePath) ? load(basePath) : [];
const headMcps = load(headPath);
const changedFiles = changedPath ? fs.readFileSync(changedPath, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [];
const sync = isSyncPr({ headRef: process.env.HEAD_REF, author: process.env.PR_AUTHOR, appLogin: process.env.SYNC_APP_LOGIN });

const errors = universalChecks({ baseMcps, headMcps, allPins });
if (sync) errors.push(...diffScope({ baseMcps, headMcps, changedFiles }));

console.log(`registry checks: ${headMcps.length} entries, sync PR: ${sync ? 'yes' : 'no'}, all-pins: ${allPins ? 'yes' : 'no'}`);
if (errors.length) {
  console.error('Registry checks FAILED:');
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log('Registry checks passed.');
