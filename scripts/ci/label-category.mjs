#!/usr/bin/env node
// Labels a registry PR by category / transport / auth (TD-056: replaces an inline actions/github-script step that
// could not require js-yaml). Runs from the BASE checkout; the PR's registry.yaml is only ever parsed as data.
//
//   node scripts/ci/label-category.mjs <registry.yaml> [--print]     (PR_NUMBER and GH_TOKEN/GH_REPO in env unless --print)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import yaml from '../lib/yaml.mjs';

export const CATEGORY_LABELS = {
  'Developer Tools': 'category: developer-tools', Productivity: 'category: productivity', 'Data & Analytics': 'category: data-analytics',
  Communication: 'category: communication', 'AI & ML': 'category: ai-ml', Security: 'category: security', Infrastructure: 'category: infrastructure',
  Finance: 'category: finance', 'Media & Entertainment': 'category: media', Education: 'category: education', 'E-commerce': 'category: ecommerce', Other: 'category: other',
};
export const TRANSPORT_LABELS = { http: 'transport: http', stdio: 'transport: stdio' };
export const AUTH_LABELS = { none: 'auth: none', static: 'auth: static', oauth2: 'auth: oauth2' };
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** Pure: the set of labels for a parsed registry document. Unknown values are ignored. */
export function labelsFor(registry) {
  const labels = new Set(['registry-pr']);
  for (const m of Array.isArray(registry?.mcps) ? registry.mcps : []) {
    if (own(CATEGORY_LABELS, m?.category)) labels.add(CATEGORY_LABELS[m.category]);
    if (own(TRANSPORT_LABELS, m?.transport_type)) labels.add(TRANSPORT_LABELS[m.transport_type]);
    if (own(AUTH_LABELS, m?.auth_type)) labels.add(AUTH_LABELS[m.auth_type]);
    if (m?.verified) labels.add('verified-entry');
  }
  return [...labels];
}

const colorOf = l => (l.startsWith('category:') ? '0075ca' : l.startsWith('transport:') ? 'e4e669' : l.startsWith('auth:') ? 'd93f0b' : 'cfd3d7');

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: label-category.mjs <registry.yaml> [--print]');
  const labels = labelsFor(yaml.load(fs.readFileSync(file, 'utf8')));
  if (process.argv.includes('--print')) { console.log(labels.join('\n')); return; }
  const pr = process.env.PR_NUMBER;
  if (!/^\d{1,9}$/.test(pr ?? '')) throw new Error('PR_NUMBER must be a number');
  const gh = args => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    for (const l of labels) { try { gh(['label', 'create', l, '--color', colorOf(l)]); } catch { /* exists, or no permission: the add below decides */ } }
    gh(['pr', 'edit', pr, '--add-label', labels.join(',')]);
    console.log(`labelled #${pr}: ${labels.join(', ')}`);
  } catch (e) {
    // Fork PRs get a read-only token: labelling is a convenience, never a failing check.
    console.log(`::warning::could not label #${pr}: ${String(e.stderr ?? e.message).split('\n')[0].slice(0, 200)}`);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
