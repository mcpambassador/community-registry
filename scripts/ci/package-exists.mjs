#!/usr/bin/env node
// TD-038: every pinned npx/uvx package@version in registry.yaml must exist on its index
// (registry.npmjs.org for npx, pypi.org for uvx). Guards against dependency squatting on names that
// were never published. Read-only, anonymous, Node 20 built-ins only.
//
//   node scripts/ci/package-exists.mjs --head registry.yaml --base <base registry.yaml>   (changed/added entries)
//   node scripts/ci/package-exists.mjs --head registry.yaml --all                          (every entry)
//
// Exit 0: all found. Exit 1: at least one package/version is missing (HTTP 404).
// Exit 3: could not verify (network error/timeout/5xx after retries) and nothing was proven missing.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from '../lib/yaml.mjs';
import { packageArg, changedEntries } from '../lib/checks.mjs';

export const TIMEOUT_MS = 10_000;
export const RETRIES = 2;

const NPM_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const NPM_VER = /^[0-9A-Za-z.+_-]+$/;
const PYPI_VER = /^[A-Za-z0-9.+!_-]+$/;

/** { runner, name, version, invalid } for an exactly pinned npx/uvx command, or null. */
export function parsePin(command) {
  const p = packageArg(command);
  if (!p || typeof p.arg !== 'string') return null;
  if (p.runner === 'npx') {
    const i = p.arg.lastIndexOf('@');
    if (i <= 0) return null;
    const name = p.arg.slice(0, i), version = p.arg.slice(i + 1);
    const pin = { runner: 'npx', name, version };
    if (!NPM_NAME.test(name) || !NPM_VER.test(version)) pin.invalid = true;
    return pin;
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==(.+)$/.exec(p.arg);
  if (!m) return null;
  const pin = { runner: 'uvx', name: m[1], version: m[2] };
  if (!PYPI_VER.test(m[2])) pin.invalid = true;
  return pin;
}

/** URL on the package's index for one exact version. */
export function indexUrl({ runner, name, version }) {
  if (runner === 'npx') {
    const enc = name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1).split('/')[0]) + '%2F' + encodeURIComponent(name.split('/')[1]) : encodeURIComponent(name);
    return `https://registry.npmjs.org/${enc}/${encodeURIComponent(version)}`;
  }
  return `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
}

/** 'found' | 'missing' | 'unknown' (+ detail). Retries network errors, timeouts and 5xx/429. */
export async function checkPin(pin, fetchImpl = globalThis.fetch, { timeoutMs = TIMEOUT_MS, retries = RETRIES } = {}) {
  const url = indexUrl(pin);
  let detail = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json' }, redirect: 'error' });
      if (res.status === 200) return { status: 'found' };
      if (res.status === 404) return { status: 'missing' };
      detail = `HTTP ${res.status}`;
    } catch (e) {
      detail = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e?.message ?? e).slice(0, 120);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  return { status: 'unknown', detail };
}

/** Check entries; returns { missing: string[], unknown: string[], checked: number }. */
export async function checkEntries(entries, fetchImpl) {
  const out = { missing: [], unknown: [], checked: 0 };
  const seen = new Map();
  for (const m of entries) {
    const pin = parsePin(m.config?.command);
    if (!pin) continue;
    if (pin.invalid) {
      out.checked++;
      out.missing.push(`[${m.name}] pinned package name or version is not a valid ${pin.runner === 'npx' ? 'npm' : 'PyPI'} identifier; not fetched`);
      continue;
    }
    const key = `${pin.runner}:${pin.name}@${pin.version}`;
    if (!seen.has(key)) seen.set(key, await checkPin(pin, fetchImpl));
    const r = seen.get(key);
    out.checked++;
    const label = `[${m.name}] ${pin.runner === 'npx' ? 'npm' : 'PyPI'} package ${pin.name}@${pin.version}`;
    if (r.status === 'missing') out.missing.push(`${label} does not exist on the index (404); a name nobody published can be registered by anyone`);
    else if (r.status === 'unknown') out.unknown.push(`${label} could not be verified (${r.detail})`);
  }
  return out;
}

async function main() {
  const arg = n => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
  const load = p => yaml.load(fs.readFileSync(p, 'utf8'))?.mcps ?? [];
  const headPath = arg('--head') ?? 'registry.yaml';
  const all = process.argv.includes('--all');
  const basePath = arg('--base');
  if (!all && !basePath) {
    console.error('usage: package-exists.mjs --head <registry.yaml> (--all | --base <base registry.yaml>)');
    process.exit(2);
  }
  const head = load(headPath);
  const scope = all ? head : (() => { const c = changedEntries(fs.existsSync(basePath) ? load(basePath) : [], head); return [...c.added, ...c.changed]; })();
  const r = await checkEntries(scope);
  console.log(`package-exists: ${r.checked} pinned package(s) checked (${all ? 'all entries' : 'changed/added entries'})`);
  for (const e of r.unknown) console.warn('::warning::' + e);
  if (r.missing.length) {
    console.error('Package existence check FAILED:');
    for (const e of r.missing) console.error('  ' + e);
    process.exit(1);
  }
  if (r.unknown.length) {
    console.error(`Could not verify ${r.unknown.length} package(s); nothing was proven missing. Re-run the job.`);
    process.exit(3);
  }
  console.log('All pinned packages exist.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
