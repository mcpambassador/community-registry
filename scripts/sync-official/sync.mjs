#!/usr/bin/env node
// Official-registry sync, job 1 (read-only): fetch → filter → look up → map → validate → write an artifact.
// Never writes registry.yaml in place and never touches git. ADR-024.
//
//   node scripts/sync-official/sync.mjs --out sync-out [--registry registry.yaml] [--max 10]
//        [--max-per-publisher 2] [--full-scan] [--now 2026-11-08T00:00:00Z] [--rows-file fixture.json]   (--rows-file replaces the network fetch; tests/dry runs)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from '../lib/yaml.mjs';
import { packageArg, pinProblem } from '../lib/checks.mjs';
import { fetchAll } from './fetch-official.mjs';
import { evaluate, cheapDrop, publisherTier, publisherKey, OFFICIAL_META_KEY } from './eligibility.mjs';
import { lookupCandidate } from './index-lookup.mjs';
import { buildEntry } from './map.mjs';
import { renderPrBody } from './pr-body.mjs';
import { githubRepoOf, fetchRepoMeta, scoreRepo } from './repo-meta.mjs';

const here = new URL('.', import.meta.url);
const readJson = f => JSON.parse(fs.readFileSync(new URL(f, here), 'utf8'));
const pkgName = arg => (arg ? arg.replace(/(?<=.)(@|==).*$/, '').toLowerCase() : undefined);

const droppedTotal = d => Object.values(d).reduce((a, b) => a + b, 0);
const stampOf = (row, nowMs) => {
  const m = row._meta?.[OFFICIAL_META_KEY];
  const t = Date.parse(m?.updatedAt ?? m?.publishedAt ?? '');
  // Missing, unparseable or future-dated (> 1 day ahead of the clock) timestamps sort last, so a bad row cannot jump the queue.
  return Number.isFinite(t) && t <= nowMs + 86_400_000 ? t : 0;
};

const OVERLAP_MS = 86_400_000;
/** Incremental-scan watermark (FB-034): newest `synced_at` of an official-registry entry minus a 1-day overlap, or undefined (→ full scan). */
export function deriveWatermark(registryText, nowMs = Date.now()) {
  let best = 0;
  const mcps = yaml.load(registryText)?.mcps;
  for (const m of Array.isArray(mcps) ? mcps : []) {
    if (m.source !== 'official-registry') continue;
    const t = Date.parse(m.synced_at ?? '');
    if (Number.isFinite(t) && t <= nowMs && t > best) best = t;
  }
  return best ? new Date(best - OVERLAP_MS).toISOString().replace(/\.\d+Z$/, 'Z') : undefined;
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One place that builds the eligibility context, so the fetcher's early filter and runSync cannot drift apart. */
export function buildContext({ registryText, deny, top }) {
  const existing = yaml.load(registryText)?.mcps ?? [];
  const takenSlugs = new Set(existing.map(m => m.name));
  const knownPackages = new Set(top.packages.map(p => p.toLowerCase()));
  for (const m of existing) { const p = pkgName(packageArg(m.config?.command)?.arg); if (p) knownPackages.add(p); }
  return {
    takenSlugs,
    existingOfficialNames: new Set(existing.map(m => m.official_name).filter(Boolean)),
    knownSlugs: new Set([...takenSlugs, ...top.slugs]),
    knownPackages,
    denyNames: new Set(deny.names ?? []),
    denyPackages: new Set((deny.packages ?? []).map(p => p.toLowerCase())),
  };
}

/** Pure-ish core: injectable rows source, lookups and validator. Returns the artifact contents. */
export async function runSync({
  registryText, rows, rawRows, skipped = [], skippedCount, dropped = {}, pages = 1, max = 10, maxPerPublisher = 2, now, lookup = lookupCandidate, validate, deny, top,
  dryRun = true, watermark, repoMeta, maxLookups = max * 5, lookupBudgetMs = 4 * 60_000, nowImpl = Date.now,
}) {
  const ctx = buildContext({ registryText, deny, top });
  const { takenSlugs } = ctx;

  const rejected = [];
  const accepted = [];
  let deferred = 0;
  let eligible = 0;
  let lookups = 0;
  const lookupStart = nowImpl();
  const nowMs = Date.parse(now);
  // Newest first by the registry's own timestamp, so the per-run cap takes fresh entries; name then version break ties.
  const sorted = [...rows].sort((a, b) => stampOf(b, nowMs) - stampOf(a, nowMs) || cmp(a.server.name, b.server.name) || cmp(a.server.version, b.server.version));
  // Pass 1 (network-free): evaluate everything, rank github-or-host-matched candidates ahead of the rest; newest-first holds within a tier.
  const queue = [];
  for (const row of sorted) {
    const v = evaluate(row, ctx);
    if (!v.ok) { rejected.push({ name: row.server.name, reason: v.reason, detail: v.detail }); continue; }
    eligible++;
    queue.push({ row, tier: publisherTier(v.plan) });
  }
  const tierCounts = { 1: 0, 2: 0 };
  for (const q of queue) tierCounts[q.tier]++;
  queue.sort((a, b) => a.tier - b.tier); // stable: keeps the newest-first order inside each tier
  // FB-036: repository quality signal for the top lookup set only (the first maxLookups queue entries), bounded by the
  // lookup budget. Archived/stale repos are rejected, unreachable ones deferred; the rest rank by score inside their tier.
  const repoStats = { checked: 0, archived: 0, stale: 0, unavailable: 0, rateLimited: false };
  const metaOf = new Map();
  let ranked = queue;
  if (repoMeta) {
    const window = queue.slice(0, maxLookups);
    const kept = [];
    for (const q of window) {
      const repo = githubRepoOf(q.row.server.repository?.url);
      if (!repo) { kept.push(q); continue; }
      let r = { error: 'unavailable' };
      if (!repoStats.rateLimited && nowImpl() - lookupStart <= lookupBudgetMs / 2) {
        repoStats.checked++;
        r = await repoMeta(repo.owner, repo.repo);
        if (r.error === 'rate-limited') repoStats.rateLimited = true;
      }
      if (!r.meta) { repoStats.unavailable++; deferred++; continue; }
      const sc = scoreRepo(r.meta, nowMs);
      if (sc.reject) { repoStats[sc.reject === 'repo-archived' ? 'archived' : 'stale']++; rejected.push({ name: q.row.server.name, reason: sc.reject }); continue; }
      q.score = sc.score;
      metaOf.set(q.row, r.meta);
      kept.push(q);
    }
    // Scored first (best score first), unscored after; stable sort keeps newest-first for ties. Tier still dominates.
    kept.sort((a, b) => a.tier - b.tier || (b.score ?? -1) - (a.score ?? -1));
    ranked = [...kept, ...queue.slice(maxLookups)];
  }
  const perPublisher = new Map();
  const acceptedTiers = { 1: 0, 2: 0 };
  let cappedByPublisher = 0;
  for (const { row, tier } of ranked) {
    const name = row.server.name;
    if (accepted.length >= max || lookups >= maxLookups) { deferred++; continue; }
    // Re-evaluate: slugs taken by entries accepted earlier in this run change the outcome.
    const v = evaluate(row, ctx);
    if (!v.ok) { rejected.push({ name, reason: v.reason, detail: v.detail }); continue; }
    const ns = publisherKey(v.plan.parsed);
    if ((perPublisher.get(ns) ?? 0) >= maxPerPublisher) { cappedByPublisher++; deferred++; continue; }
    if (nowImpl() - lookupStart > lookupBudgetMs) throw new Error(`lookup time budget (${Math.round(lookupBudgetMs / 1000)}s) exhausted after ${lookups} lookups`);
    lookups++;
    let enrich;
    try { enrich = await lookup(v.plan, nowMs); } catch (e) { rejected.push({ name, reason: 'index-lookup-failed', detail: String(e.message).slice(0, 80) }); continue; }
    if (!enrich.ok) { rejected.push({ name, reason: enrich.reason }); continue; }
    const built = buildEntry(v.plan, row.server, enrich, now);
    if (built.error) { rejected.push({ name, reason: 'text-lint', detail: built.error.slice(0, 100) }); continue; }
    const bad = validate(built.entry) ?? pinProblem(built.entry.config.command);
    if (bad) { rejected.push({ name, reason: 'schema-or-pin', detail: String(bad).slice(0, 100) }); continue; }
    takenSlugs.add(built.entry.name);
    ctx.knownSlugs.add(built.entry.name);
    perPublisher.set(ns, (perPublisher.get(ns) ?? 0) + 1);
    acceptedTiers[tier]++;
    accepted.push({ entry: built.entry, plan: v.plan, tier, repo: metaOf.get(row) });
  }
  const scope = { tierCounts, acceptedTiers, cappedByPublisher, maxPerPublisher, publishers: perPublisher.size, repoStats: repoMeta ? repoStats : undefined };

  let text = registryText.endsWith('\n') ? registryText : registryText + '\n';
  if (accepted.length) text += yaml.dump(accepted.map(a => a.entry), { lineWidth: 100, noRefs: true, noArrayIndent: true });
  const date = now.slice(0, 10);
  const body = renderPrBody({ accepted, rejected, skipped, stats: { rows: rawRows ?? rows.length, pages, rejected: rejected.length + droppedTotal(dropped), deferred, skipped: skippedCount ?? skipped.length }, dropped, date, dryRun, scope, watermark });
  return { registryText: text, body, scope, accepted, rejected, deferred, eligible, lookups, branch: `sync/official-${date}`, date };
}

async function main() {
  const arg = n => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
  const out = arg('--out') ?? 'sync-out';
  const regPath = arg('--registry') ?? 'registry.yaml';
  const max = Number(arg('--max') ?? 10);
  const maxPerPublisher = Number(arg('--max-per-publisher') ?? 2);
  const now = arg('--now') ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error('--max must be 1..50');
  if (!Number.isInteger(maxPerPublisher) || maxPerPublisher < 1 || maxPerPublisher > 50) throw new Error('--max-per-publisher must be 1..50');
  if (!/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/.test(now)) throw new Error('--now must be an ISO UTC timestamp');
  const { makeValidator } = await import('./schema-validate.mjs');
  const deny = yaml.load(fs.readFileSync(new URL('denylist.yaml', here), 'utf8')) ?? {};
  const registryText = fs.readFileSync(regPath, 'utf8');
  const top = readJson('top-packages.json');
  // Network-free early filter for the fetcher: the same context builder runSync uses, but only the no-slug-state rules apply.
  const earlyCtx = buildContext({ registryText, deny, top });
  const watermark = process.argv.includes('--full-scan') ? undefined : deriveWatermark(registryText, Date.parse(now));
  console.error(watermark ? `scan: incremental, updated_since ${watermark}` : 'scan: full (no watermark or --full-scan)');
  const feed = arg('--rows-file')
    ? { rows: JSON.parse(fs.readFileSync(arg('--rows-file'), 'utf8')), skipped: [], pages: 1 }
    : await fetchAll({ keep: row => { const v = cheapDrop(row, earlyCtx); return v.ok ? undefined : v.reason; }, updatedSince: watermark });
  if (feed.dropped) console.error(`fetched ${feed.rawRows} raw rows in ${feed.pages} pages; kept ${feed.rows.length}; dropped ${JSON.stringify(feed.dropped)}`);
  const res = await runSync({
    registryText, ...feed, max, maxPerPublisher, watermark, now, validate: makeValidator(),
    deny, top, dryRun: process.argv.includes('--dry-run'),
    // Offline runs (--rows-file) never call GitHub. GITHUB_TOKEN is optional and read-only; it is only ever sent to api.github.com.
    repoMeta: arg('--rows-file') ? undefined : (owner, repo) => fetchRepoMeta(owner, repo, { token: process.env.GITHUB_TOKEN }),
  });
  const byReason = {};
  for (const r of res.rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const sortDesc = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const skippedN = feed.skippedCount ?? feed.skipped?.length ?? 0;
  const cheapN = Object.values(feed.dropped ?? {}).reduce((a, b) => a + b, 0);
  console.error(`funnel: ${feed.rawRows ?? feed.rows.length} raw rows − ${skippedN} skipped (unknown $schema/malformed) − ${cheapN} cheap-dropped = ${feed.rows.length} kept → ${res.eligible} eligible candidates (before --max ${max}) → ${res.accepted.length} proposed; ${res.lookups} lookups`);
  console.error(`tiers: eligible ${res.scope.tierCounts[1]} github-or-host-matched / ${res.scope.tierCounts[2]} other; proposed ${res.scope.acceptedTiers[1]} / ${res.scope.acceptedTiers[2]}; ${res.scope.publishers} publishers, cap ${maxPerPublisher} each held back ${res.scope.cappedByPublisher}`);
  if (res.scope.repoStats) { const r = res.scope.repoStats; console.error(`repo-meta: ${r.checked} checked, ${r.archived} archived, ${r.stale} stale (no push in 12 months), ${r.unavailable} unavailable/deferred${r.rateLimited ? ' (GitHub rate limit hit)' : ''}`); }
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
