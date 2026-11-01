#!/usr/bin/env node
// TD-018: pin every unpinned npx/uvx entry to the current registry version and record package_integrity.
// Built-ins only. Edits registry.yaml as text (no YAML round-trip) so the diff stays minimal.
// Usage: node scripts/sync-official/pin-existing.mjs [--write] [registry.yaml]
// Default is a dry run that prints the plan. Packages that do not exist are reported, never silently kept.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 5 * 1024 * 1024;
const NPM_VERSION = /^\d+\.\d+\.\d+$/;
const PYPI_VERSION = /^\d+(\.\d+){0,3}(\.post\d+)?$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Fetch JSON with a size cap and timeout. Returns {status, json}. */
export async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`${url}: response too large`);
  return { status: 200, json: JSON.parse(buf.toString('utf8')) };
}

export async function lookupNpm(name, get = fetchJson) {
  if (!NPM_NAME.test(name)) return { error: `invalid npm name ${name}` };
  const r = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`);
  if (r.status === 404) return { missing: true };
  const { version, dist } = r.json ?? {};
  if (typeof version !== 'string' || !NPM_VERSION.test(version)) return { error: `latest of ${name} is not a plain x.y.z (${version})` };
  const integrity = dist?.integrity;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) return { error: `no sha512 integrity for ${name}@${version}` };
  return { version, integrity };
}

export async function lookupPypi(name, get = fetchJson) {
  if (!PYPI_NAME.test(name)) return { error: `invalid pypi name ${name}` };
  const r = await get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (r.status === 404) return { missing: true };
  const version = r.json?.info?.version;
  if (typeof version !== 'string' || !PYPI_VERSION.test(version)) return { error: `latest of ${name} is not a plain release (${version})` };
  const files = (r.json.urls ?? []).filter(f => !f.yanked);
  const digests = [...new Set(files.map(f => f.digests?.sha256).filter(d => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d)))].sort();
  if (digests.length === 0) return { error: `no file digests for ${name}==${version}` };
  return { version, integrity: digests };
}

const stripQuotes = s => s.replace(/^(['"])(.*)\1$/, '$2');

/**
 * Plan pins over registry text. Returns { text, pinned, missing, errors }.
 * Only touches entries whose npx/uvx package argument is not already an exact pin.
 */
export async function planPins(text, { npm = lookupNpm, pypi = lookupPypi } = {}) {
  const lines = text.split('\n');
  const starts = lines.flatMap((l, i) => (/^- name: /.test(l) ? [i] : []));
  const pinned = [], missing = [], errors = [];
  const inserts = []; // {at, lines}
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const name = stripQuotes(lines[s].slice('- name: '.length).trim());
    const ci = lines.slice(s, e).findIndex(l => /^ {4}command:\s*$/.test(l));
    if (ci < 0) continue;
    const c = s + ci;
    const items = [];
    for (let i = c + 1; i < e && /^ {4}- /.test(lines[i]); i++) items.push(i);
    const runner = items.length ? stripQuotes(lines[items[0]].slice(6).trim()) : '';
    if (runner !== 'npx' && runner !== 'uvx') continue;
    const argIdx = items.slice(1).find(i => !stripQuotes(lines[i].slice(6).trim()).startsWith('-'));
    if (argIdx === undefined) { errors.push(`${name}: no package argument`); continue; }
    const raw = lines[argIdx].slice(6).trim();
    const arg = stripQuotes(raw);
    const exact = runner === 'npx' ? /^(@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+$/.test(arg) : /^[A-Za-z0-9._-]+==\d+(\.\d+)*$/.test(arg);
    if (exact) continue;
    const base = runner === 'npx' ? arg.replace(/(?<=.)@(latest|[^/@]*)$/, '') : arg.replace(/(==|>=|~=).*$/, '');
    let r;
    try { r = await (runner === 'npx' ? npm(base) : pypi(base)); } catch (err) { errors.push(`${name}: ${err.message}`); continue; }
    if (r.missing) { missing.push({ name, package: base, runner }); continue; }
    if (r.error) { errors.push(`${name}: ${r.error}`); continue; }
    const pinnedArg = runner === 'npx' ? `${base}@${r.version}` : `${base}==${r.version}`;
    const quoted = /^['"]/.test(raw) ? `'${pinnedArg}'` : pinnedArg;
    lines[argIdx] = `    - ${quoted}`;
    const integ = runner === 'npx'
      ? ['  package_integrity:', `    npm: ${r.integrity}`]
      : ['  package_integrity:', '    pypi:', ...r.integrity.map(d => `    - ${d}`)];
    // insert before the next entry (end of this entry's block), after any blank/comment tail
    let at = e; while (at > s && lines[at - 1].trim() === '') at--;
    inserts.push({ at, lines: integ });
    pinned.push({ name, from: arg, to: pinnedArg });
  }
  for (const ins of inserts.sort((a, b) => b.at - a.at)) lines.splice(ins.at, 0, ...ins.lines);
  return { text: lines.join('\n'), pinned, missing, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const file = args.find(a => !a.startsWith('--')) ?? 'registry.yaml';
  const out = await planPins(fs.readFileSync(file, 'utf8'));
  for (const p of out.pinned) console.log(`pin   ${p.name}: ${p.from} -> ${p.to}`);
  for (const m of out.missing) console.log(`MISSING ${m.name}: ${m.runner} package "${m.package}" does not exist on the index (remove or fix the entry)`);
  for (const e of out.errors) console.log(`ERROR ${e}`);
  if (write && out.pinned.length) fs.writeFileSync(file, out.text);
  console.log(`${write ? 'wrote' : 'dry run'}: ${out.pinned.length} pinned, ${out.missing.length} missing, ${out.errors.length} errors`);
  process.exitCode = out.errors.length ? 1 : 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
