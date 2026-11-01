#!/usr/bin/env node
// Official-registry sync, job 1 (read-only): fetch → filter → look up → map → validate → write an artifact.
// Never writes registry.yaml in place and never touches git. ADR-024.
//
//   node scripts/sync-official/sync.mjs --out sync-out [--registry registry.yaml] [--max 10]
//        [--now 2026-11-08T00:00:00Z] [--rows-file fixture.json]   (--rows-file replaces the network fetch; tests/dry runs)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from '../lib/yaml.mjs';
import { packageArg, pinProblem } from '../lib/checks.mjs';
import { fetchAll } from './fetch-official.mjs';
import { evaluate, cheapDrop } from './eligibility.mjs';
import { lookupCandidate } from './index-lookup.mjs';
import { buildEntry } from './map.mjs';
import { renderPrBody } from './pr-body.mjs';

const here = new URL('.', import.meta.url);
const readJson = f => JSON.parse(fs.readFileSync(new URL(f, here), 'utf8'));
const pkgName = arg => (arg ? arg.replace(/(?<=.)(@|==).*$/, '').toLowerCase() : undefined);

/** Pure-ish core: injectable rows source, lookups and validator. Returns the artifact contents. */
export async function runSync({ registryText, rows, rawRows, skipped = [], pages = 1, max = 10, now, lookup = lookupCandidate, validate, deny, top, dryRun = true }) {
  const doc = yaml.load(registryText);
  const existing = doc?.mcps ?? [];
  const takenSlugs = new Set(existing.map(m => m.name));
  const knownPackages = new Set(top.packages.map(p => p.toLowerCase()));
  for (const m of existing) { const p = pkgName(packageArg(m.config?.command)?.arg); if (p) knownPackages.add(p); }
  const ctx = {
    takenSlugs,
    existingOfficialNames: new Set(existing.map(m => m.official_name).filter(Boolean)),
    knownSlugs: new Set([...takenSlugs, ...top.slugs]),
    knownPackages,
    denyNames: new Set(deny.names ?? []),
    denyPackages: new Set((deny.packages ?? []).map(p => p.toLowerCase())),
  };

  const rejected = [];
  const accepted = [];
  let deferred = 0;
  let eligible = 0;
  const sorted = [...rows].sort((a, b) => a.server.name.localeCompare(b.server.name) || a.server.version.localeCompare(b.server.version));
  const nowMs = Date.parse(now);
  for (const row of sorted) {
    const name = row.server.name;
    const v = evaluate(row, ctx);
    if (!v.ok) { rejected.push({ name, reason: v.reason, detail: v.detail }); continue; }
    eligible++;
    if (accepted.length >= max) { deferred++; continue; }
    let enrich;
    try { enrich = await lookup(v.plan, nowMs); } catch (e) { rejected.push({ name, reason: 'index-lookup-failed', detail: String(e.message).slice(0, 80) }); continue; }
    if (!enrich.ok) { rejected.push({ name, reason: enrich.reason }); continue; }
    const built = buildEntry(v.plan, row.server, enrich, now);
    if (built.error) { rejected.push({ name, reason: 'text-lint', detail: built.error.slice(0, 100) }); continue; }
    const bad = validate(built.entry) ?? pinProblem(built.entry.config.command);
    if (bad) { rejected.push({ name, reason: 'schema-or-pin', detail: String(bad).slice(0, 100) }); continue; }
    takenSlugs.add(built.entry.name);
    ctx.knownSlugs.add(built.entry.name);
    accepted.push({ entry: built.entry, plan: v.plan });
  }

  let text = registryText.endsWith('\n') ? registryText : registryText + '\n';
  if (accepted.length) text += yaml.dump(accepted.map(a => a.entry), { lineWidth: 100, noRefs: true, noArrayIndent: true });
  const date = now.slice(0, 10);
  const body = renderPrBody({ accepted, rejected, skipped, stats: { rows: rawRows ?? rows.length, pages, rejected: rejected.length, deferred }, date, dryRun });
  return { registryText: text, body, accepted, rejected, deferred, eligible, branch: `sync/official-${date}`, date };
}

async function main() {
  const arg = n => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
  const out = arg('--out') ?? 'sync-out';
  const regPath = arg('--registry') ?? 'registry.yaml';
  const max = Number(arg('--max') ?? 10);
  const now = arg('--now') ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error('--max must be 1..50');
  if (!/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/.test(now)) throw new Error('--now must be an ISO UTC timestamp');
  const { makeValidator } = await import('./schema-validate.mjs');
  const deny = yaml.load(fs.readFileSync(new URL('denylist.yaml', here), 'utf8')) ?? {};
  const registryText = fs.readFileSync(regPath, 'utf8');
  // Network-free early filter for the fetcher: only rules that need no slug state or package lookup.
  const earlyCtx = {
    denyNames: new Set(deny.names ?? []),
    existingOfficialNames: new Set((yaml.load(registryText)?.mcps ?? []).map(m => m.official_name).filter(Boolean)),
  };
  const feed = arg('--rows-file')
    ? { rows: JSON.parse(fs.readFileSync(arg('--rows-file'), 'utf8')), skipped: [], pages: 1 }
    : await fetchAll({ keep: row => { const v = cheapDrop(row, earlyCtx); return v.ok ? undefined : v.reason; } });
  if (feed.dropped) console.error(`fetched ${feed.rawRows} raw rows in ${feed.pages} pages; kept ${feed.rows.length}; dropped ${JSON.stringify(feed.dropped)}`);
  const res = await runSync({
    registryText, ...feed, max, now, validate: makeValidator(),
    deny, top: readJson('top-packages.json'), dryRun: process.argv.includes('--dry-run'),
  });
  const byReason = {};
  for (const r of res.rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const sortDesc = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  console.error(`funnel: ${feed.rawRows ?? feed.rows.length} raw rows → ${feed.rows.length} after cheap drop → ${res.eligible} eligible candidates (before --max ${max}) → ${res.accepted.length} proposed`);
  console.error(`cheap-dropped by reason: ${JSON.stringify(sortDesc(feed.dropped ?? {}))}`);
  console.error(`rejected by reason: ${JSON.stringify(sortDesc(byReason))}`);
  console.error(`heapUsed: ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'registry.yaml'), res.registryText);
  fs.writeFileSync(path.join(out, 'pr-body.md'), res.body);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({
    branch: res.branch, proposed: res.accepted.map(a => a.entry.name), rejected: res.rejected.length, deferred: res.deferred,
  }, null, 2) + '\n');
  console.log(`${res.accepted.length} proposed, ${res.rejected.length} rejected, ${res.deferred} deferred → ${out}/`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_changes=${res.accepted.length > 0}\nbranch=${res.branch}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
