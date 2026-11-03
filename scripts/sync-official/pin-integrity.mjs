#!/usr/bin/env node
// TD-074: record package_integrity.npm (sha512 SRI from the npm index) for every exactly pinned npx entry.
// Built-ins only. Edits registry.yaml as text so the diff stays minimal. Read-only against the index; nothing is installed or run.
// Usage: node scripts/sync-official/pin-integrity.mjs [--write] [registry.yaml]
// Default is a dry run. Existing package_integrity.npm values are never overwritten (package-exists.mjs flags a mismatch).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getJson } from './fetch-official.mjs';
import { lookupNpm } from './pin-existing.mjs';
import { packageArg, NPM_PIN } from '../lib/checks.mjs';

const stripQuotes = s => s.replace(/^(['"])(.*)\1$/, '$2');

/** Index lookup for one exact version (shared with pin-existing.mjs). */
export async function lookupNpmVersion(name, version, get = getJson) {
  const r = await lookupNpm(name, get, version);
  return r.integrity ? { integrity: r.integrity } : r;
}

/** Returns { text, added, errors }. Only touches entries whose npx package argument is an exact pin with no package_integrity.npm. */
export async function planIntegrity(text, { npm = lookupNpmVersion } = {}) {
  const lines = text.split('\n');
  const starts = lines.flatMap((l, i) => (/^- name: /.test(l) ? [i] : []));
  const added = [], errors = [], inserts = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    // The last entry ends at the next top-level key (so a key after `mcps:` never receives inserts), not at EOF.
    let e = k + 1 < starts.length ? starts[k + 1] : lines.length;
    if (k + 1 === starts.length) for (let i = s + 1; i < lines.length; i++) if (/^[A-Za-z_]/.test(lines[i])) { e = i; break; }
    const name = stripQuotes(lines[s].slice('- name: '.length).trim());
    const ci = lines.slice(s, e).findIndex(l => /^ {4}command:\s*$/.test(l));
    if (ci < 0) continue;
    const items = [];
    for (let i = s + ci + 1; i < e && /^ {4}- /.test(lines[i]); i++) items.push(stripQuotes(lines[i].slice(6).trim()));
    const p = packageArg(items);
    if (p?.runner !== 'npx' || typeof p.arg !== 'string' || !NPM_PIN.test(p.arg)) continue;
    const arg = p.arg;
    const block = lines.slice(s, e);
    const pi = block.findIndex(l => /^ {2}package_integrity:\s*$/.test(l));
    if (pi >= 0 && block.slice(pi + 1).some(l => /^ {4}npm:/.test(l))) continue;
    if (pi >= 0) { errors.push(`${name}: has a package_integrity block without npm; edit by hand`); continue; }
    const at = arg.lastIndexOf('@');
    let r;
    try { r = await npm(arg.slice(0, at), arg.slice(at + 1)); } catch (err) { errors.push(`${name}: ${err.message}`); continue; }
    if (r.missing) { errors.push(`${name}: ${arg} does not exist on npm`); continue; }
    if (r.error) { errors.push(`${name}: ${r.error}`); continue; }
    let ins = e; while (ins > s && lines[ins - 1].trim() === '') ins--;
    inserts.push({ at: ins, lines: ['  package_integrity:', `    npm: ${r.integrity}`] });
    added.push({ name, package: arg, integrity: r.integrity });
  }
  for (const ins of inserts.sort((a, b) => b.at - a.at)) lines.splice(ins.at, 0, ...ins.lines);
  return { text: lines.join('\n'), added, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const file = args.find(a => !a.startsWith('--')) ?? 'registry.yaml';
  const out = await planIntegrity(fs.readFileSync(file, 'utf8'));
  for (const a of out.added) console.log(`pin   ${a.name}: ${a.package} ${a.integrity}`);
  for (const e of out.errors) console.log(`ERROR ${e}`);
  if (write && out.added.length) fs.writeFileSync(file, out.text);
  console.log(`${write ? 'wrote' : 'dry run'}: ${out.added.length} integrity pins, ${out.errors.length} errors`);
  process.exitCode = out.errors.length ? 1 : 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
