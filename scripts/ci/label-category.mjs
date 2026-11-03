#!/usr/bin/env node
// Labels a registry PR by category / transport / auth of the entries it ADDS OR CHANGES (TD-056: replaces an inline
// actions/github-script step that could not require js-yaml). The PR's registry.yaml is only ever parsed as data
// (vendored js-yaml, no npm install needed).
//
//   node scripts/ci/label-category.mjs <head registry.yaml> --base <base registry.yaml> [--print]
//   env (unless --print): PR_NUMBER, GH_TOKEN, GH_REPO; IS_FORK=true downgrades label failures to a warning.
//   LABEL_GH_BIN overrides the `gh` binary (tests only; ignored when CI=true so a PR can never swap the binary in Actions).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import yaml from '../lib/yaml.mjs';

// The registry schema leaves `category` a free string; these are the values in use (plus the sync's default).
export const CATEGORY_LABELS = {
  'AI & Reasoning': 'category: ai-reasoning', Business: 'category: business', 'Data & Search': 'category: data-search',
  'Developer Tools': 'category: developer-tools', 'Finance & Data': 'category: finance-data', Productivity: 'category: productivity',
  Uncategorized: 'category: uncategorized',
};
export const TRANSPORT_LABELS = { http: 'transport: http', stdio: 'transport: stdio' };
export const AUTH_LABELS = { none: 'auth: none', static: 'auth: static', oauth2: 'auth: oauth2' };
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

const mcpsOf = r => (Array.isArray(r?.mcps) ? r.mcps.filter(m => m && typeof m === 'object') : []);

/** Entries of `head` that are new or differ from the same-named entry in `base`. */
export function changedEntries(head, base) {
  const before = new Map(mcpsOf(base).map(m => [m.name, m]));
  return mcpsOf(head).filter(m => !before.has(m.name) || !isDeepStrictEqual(before.get(m.name), m));
}

/** Pure: the label set for the entries a PR adds or changes. Unknown values are ignored; an unchanged file gets only `registry-pr`. */
export function labelsFor(head, base) {
  const labels = new Set(['registry-pr']);
  for (const m of changedEntries(head, base)) {
    if (own(CATEGORY_LABELS, m?.category)) labels.add(CATEGORY_LABELS[m.category]);
    if (own(TRANSPORT_LABELS, m?.transport_type)) labels.add(TRANSPORT_LABELS[m.transport_type]);
    if (own(AUTH_LABELS, m?.auth_type)) labels.add(AUTH_LABELS[m.auth_type]);
    if (m?.verified) labels.add('verified-entry');
  }
  return [...labels];
}

const colorOf = l => (l.startsWith('category:') ? '0075ca' : l.startsWith('transport:') ? 'e4e669' : l.startsWith('auth:') ? 'd93f0b' : 'cfd3d7');

/** The `gh` binary: the LABEL_GH_BIN test hook is honoured only outside CI. */
export const ghBin = (env = process.env) => (String(env.CI).toLowerCase() === 'true' ? 'gh' : env.LABEL_GH_BIN || 'gh');

function main() {
  const file = process.argv[2];
  const bi = process.argv.indexOf('--base');
  if (!file || bi === -1 || !process.argv[bi + 1]) throw new Error('usage: label-category.mjs <head registry.yaml> --base <base registry.yaml> [--print]');
  const load = f => yaml.load(fs.readFileSync(f, 'utf8'));
  const labels = labelsFor(load(file), load(process.argv[bi + 1]));
  if (process.argv.includes('--print')) { console.log(labels.join('\n')); return; }
  const pr = process.env.PR_NUMBER;
  if (!/^\d{1,9}$/.test(pr ?? '')) throw new Error('PR_NUMBER must be a number');
  const gh = args => execFileSync(ghBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  try {
    for (const l of labels) { try { gh(['label', 'create', l, '--color', colorOf(l)]); } catch { /* exists, or no permission: the add below decides */ } }
    gh(['pr', 'edit', pr, '--add-label', labels.join(',')]);
    console.log(`labelled #${pr}: ${labels.join(', ')}`);
  } catch (e) {
    const why = String(e.stderr ?? e.message).split('\n')[0].slice(0, 200);
    // Fork PRs get a read-only token and are never labelled: a warning. A same-repo PR must be labellable: fail the job.
    if (process.env.IS_FORK === 'true') { console.log(`::warning::could not label #${pr} (fork PR, read-only token): ${why}`); return; }
    console.error(`::error::could not label #${pr}: ${why}`);
    process.exitCode = 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
