// FB-034: verified-first ranking, per-publisher cap, updated_since watermark.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OFFICIAL_META_KEY, publisherTier, evaluate } from '../sync-official/eligibility.mjs';
import { fetchAll, ALLOWED_SCHEMAS } from '../sync-official/fetch-official.mjs';
import { runSync, deriveWatermark } from '../sync-official/sync.mjs';
import { makeValidator } from '../sync-official/schema-validate.mjs';

const SCHEMA = [...ALLOWED_SCHEMAS][0];
const registryText = fs.readFileSync(new URL('../../registry.yaml', import.meta.url), 'utf8');
const top = JSON.parse(fs.readFileSync(new URL('../sync-official/top-packages.json', import.meta.url), 'utf8'));
const validate = makeValidator();
const NOW = '2026-11-08T00:00:00Z';
const row = (server, meta = {}) => ({ server: { $schema: SCHEMA, version: '1.0.0', description: 'd', ...server }, _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true, ...meta } } });
const npmRow = (name, meta = {}) => row({ name, packages: [{ registryType: 'npm', identifier: name.split('/')[1] + '-mcp', version: '1.2.3', transport: { type: 'stdio' } }] }, meta);
const remoteRow = (name, url, meta = {}) => row({ name, remotes: [{ type: 'streamable-http', url }] }, meta);
const okLookup = async plan => (plan.kind === 'remote' ? { ok: true, flags: [] } : { ok: true, dependenciesPinned: false, flags: ['dependencies-unpinned'], packageIntegrity: { npm: 'sha512-AAAA' } });
const sync = (rows, over = {}) => runSync({ registryText, rows, now: NOW, lookup: okLookup, validate, deny: { names: [], packages: [] }, top, ...over });
const names = res => res.accepted.map(a => a.plan.officialName);
const ctx = { takenSlugs: new Set(), existingOfficialNames: new Set(), knownSlugs: new Set(), knownPackages: new Set(), denyNames: new Set(), denyPackages: new Set() };

test('publisherTier: github and host-matched remotes are tier 1; mismatch, packages under a domain are tier 2', () => {
  const tier = r => publisherTier(evaluate(r, ctx).plan);
  assert.equal(tier(npmRow('io.github.acme/a')), 1);
  assert.equal(tier(remoteRow('com.acme/a', 'https://mcp.acme.com/mcp')), 1);
  assert.equal(tier(remoteRow('com.acme/b', 'https://other.example.net/mcp')), 2);
  assert.equal(tier(npmRow('com.acme/c')), 2);
});

test('ranking: verified tier first, newest-first inside each tier, even when --max cuts the list', async () => {
  const rows = [
    npmRow('com.zzz/newest-unverified', { updatedAt: '2026-11-07T00:00:00Z' }),
    npmRow('io.github.old/verified-old', { updatedAt: '2026-09-01T00:00:00Z' }),
    remoteRow('com.acme/verified-remote', 'https://api.acme.com/mcp', { updatedAt: '2026-10-01T00:00:00Z' }),
    remoteRow('com.mismatch/remote', 'https://elsewhere.example.net/mcp', { updatedAt: '2026-11-06T00:00:00Z' }),
  ];
  const all = await sync(rows, { max: 10 });
  assert.deepEqual(names(all), ['com.acme/verified-remote', 'io.github.old/verified-old', 'com.zzz/newest-unverified', 'com.mismatch/remote']);
  assert.deepEqual(all.scope.tierCounts, { 1: 2, 2: 2 });
  const cut = await sync(rows, { max: 2 });
  assert.deepEqual(names(cut), ['com.acme/verified-remote', 'io.github.old/verified-old']);
  assert.deepEqual(cut.scope.acceptedTiers, { 1: 2, 2: 0 });
});

test('per-publisher cap: at most N per namespace, others fill the slots; default 2', async () => {
  const rows = [1, 2, 3, 4].map(i => npmRow(`io.github.big/t${i}`, { updatedAt: `2026-11-0${i}T00:00:00Z` }));
  rows.push(npmRow('io.github.small/one', { updatedAt: '2026-01-01T00:00:00Z' }));
  const res = await sync(rows, { max: 10 });
  assert.deepEqual(names(res), ['io.github.big/t4', 'io.github.big/t3', 'io.github.small/one']);
  assert.equal(res.scope.cappedByPublisher, 2);
  assert.equal(res.deferred, 2);
  assert.equal(res.scope.publishers, 2);
  const one = await sync(rows, { max: 10, maxPerPublisher: 1 });
  assert.deepEqual(names(one), ['io.github.big/t4', 'io.github.small/one']);
});

test('per-publisher cap counts accepted entries only: a lookup rejection does not use a slot', async () => {
  const rows = [1, 2, 3].map(i => npmRow(`io.github.big/t${i}`, { updatedAt: `2026-11-0${i}T00:00:00Z` }));
  const lookup = async (plan, now) => (plan.officialName.endsWith('t3') ? { ok: false, reason: 'package-not-found' } : okLookup(plan, now));
  const res = await sync(rows, { max: 10, maxPerPublisher: 1, lookup });
  assert.deepEqual(names(res), ['io.github.big/t2']);
});

test('PR body shows the scope line', async () => {
  const res = await sync([npmRow('io.github.a/x'), npmRow('com.b/y')], { watermark: '2026-11-01T00:00:00Z' });
  assert.match(res.body, /incremental scan, updated since `2026-11-01T00:00:00Z`/);
  assert.match(res.body, /1 verified-namespace, 1 other/);
  assert.match((await sync([npmRow('io.github.a/x')])).body, /full scan/);
});

test('deriveWatermark: newest official synced_at minus one day; ignores other sources, future and bad stamps', () => {
  const reg = t => `mcps:\n${t.map(([s, at], i) => `- name: m${i}\n  source: ${s}\n  synced_at: ${at}\n`).join('')}`;
  assert.equal(deriveWatermark(reg([['official-registry', '2026-10-20T06:00:00Z'], ['official-registry', '2026-11-01T06:00:00Z']]), Date.parse(NOW)), '2026-10-31T06:00:00Z');
  assert.equal(deriveWatermark(reg([['community', '2026-11-01T06:00:00Z']]), Date.parse(NOW)), undefined);
  assert.equal(deriveWatermark(reg([['official-registry', '2030-01-01T00:00:00Z'], ['official-registry', 'garbage']]), Date.parse(NOW)), undefined);
  assert.equal(deriveWatermark('mcps: []\n'), undefined);
  assert.equal(deriveWatermark(registryText, Date.parse(NOW)), undefined, 'live registry has no official entries yet, or this test needs updating');
});

test('fetchAll passes updated_since only when given', async () => {
  const urls = [];
  const fetchImpl = async u => { urls.push(String(u)); return new Response(JSON.stringify({ servers: [], metadata: {} })); };
  await fetchAll({ fetchImpl, updatedSince: '2026-11-01T00:00:00Z' });
  await fetchAll({ fetchImpl });
  assert.match(urls[0], /&version=latest&updated_since=2026-11-01T00%3A00%3A00Z/);
  assert.doesNotMatch(urls[1], /updated_since/);
});
