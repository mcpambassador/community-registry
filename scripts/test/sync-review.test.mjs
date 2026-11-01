import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cheapDrop, OFFICIAL_META_KEY } from '../sync-official/eligibility.mjs';
import { LIMITS, fetchAll, ALLOWED_SCHEMAS } from '../sync-official/fetch-official.mjs';
import { runSync, buildContext } from '../sync-official/sync.mjs';
import { makeValidator } from '../sync-official/schema-validate.mjs';

const SCHEMA = [...ALLOWED_SCHEMAS][0];
const registryText = fs.readFileSync(new URL('../../registry.yaml', import.meta.url), 'utf8');
const top = JSON.parse(fs.readFileSync(new URL('../sync-official/top-packages.json', import.meta.url), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/official-rows.json', import.meta.url), 'utf8'));
const validate = makeValidator();
const NOW = '2026-11-08T00:00:00Z';
const deny = { names: [], packages: [] };

const row = (server, meta = {}) => ({ server: { $schema: SCHEMA, version: '1.0.0', description: 'd', ...server }, _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true, ...meta } } });
const npmPkg = (over = {}) => ({ registryType: 'npm', identifier: 'thing-mcp', version: '1.2.3', transport: { type: 'stdio' }, ...over });
const npmRow = (name, meta = {}, over = {}) => row({ name, packages: [npmPkg({ identifier: name.split('/')[1], ...over })] }, meta);
const jsonRes = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
const okLookup = async plan => (plan.kind === 'remote' ? { ok: true, flags: [] } : { ok: true, dependenciesPinned: false, flags: ['dependencies-unpinned'], packageIntegrity: plan.kind === 'npm' ? { npm: 'sha512-AAAA' } : { pypi: ['a'.repeat(64)] } });
const sync = (rows, over = {}) => runSync({ registryText, rows, now: NOW, lookup: okLookup, validate, deny, top, ...over });

test('cheapDrop: every reason it can give, and ok otherwise', () => {
  const c = { denyNames: new Set(['io.github.acme/denied']), existingOfficialNames: new Set(['io.github.acme/have']) };
  const reason = r => cheapDrop(r, c).reason;
  assert.equal(reason(npmRow('io.github.acme/a', { status: 'deprecated' })), 'status-not-active');
  assert.equal(reason(npmRow('io.github.acme/a', { isLatest: false })), 'not-latest');
  assert.equal(reason(npmRow('nonamespace')), 'bad-name');
  assert.equal(reason(npmRow('io.github.acme/denied')), 'deny-listed');
  assert.equal(reason(npmRow('io.github.acme/have')), 'already-synced');
  assert.equal(reason(row({ name: 'io.github.acme/a', packages: [{ registryType: 'oci', identifier: 'x', version: '1', transport: { type: 'stdio' } }] })), 'unsupported-type');
  assert.equal(reason(row({ name: 'io.github.acme/a', packages: [npmPkg(), npmPkg({ identifier: 'b' })] })), 'ambiguous-multiple-runnable');
  assert.equal(cheapDrop(npmRow('io.github.acme/a'), c).ok, true);
});

test('runSync gives the same proposals with and without the fetcher pre-filter', async () => {
  const rows = [...fixtures, npmRow('io.github.zed/old', { status: 'deprecated' }), row({ name: 'bad', packages: [npmPkg()] })];
  const early = buildContext({ registryText, deny, top });
  const kept = [], dropped = {};
  for (const r of rows) { const v = cheapDrop(r, early); if (v.ok) kept.push(r); else dropped[v.reason] = (dropped[v.reason] ?? 0) + 1; }
  assert.ok(kept.length < rows.length);
  const full = await sync(rows);
  const pre = await sync(kept, { rawRows: rows.length, dropped });
  assert.deepEqual(pre.accepted.map(a => a.entry), full.accepted.map(a => a.entry));
  assert.equal(pre.registryText, full.registryText);
  assert.equal(pre.eligible, full.eligible);
  // the funnel adds up in the PR body: rejected counts include the cheap drops
  const total = full.rejected.length;
  assert.match(pre.body, new RegExp(`${total} rejected`));
});

test('lookups are bounded: every lookup failing still stops at max*5, the rest are deferred', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => npmRow(`io.github.acme/p${i}`));
  let calls = 0;
  const res = await sync(rows, { max: 3, lookup: async () => { calls++; throw new Error('index down'); } });
  assert.equal(calls, 15);
  assert.equal(res.lookups, 15);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.deferred, 185);
  assert.equal(res.rejected.filter(r => r.reason === 'index-lookup-failed').length, 15);
});

test('lookup phase has its own wall-clock budget and fails closed', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => npmRow(`io.github.acme/q${i}`));
  let t = 0;
  await assert.rejects(sync(rows, { max: 10, nowImpl: () => t, lookupBudgetMs: 1000, lookup: async () => { t += 600; throw new Error('slow'); } }), /lookup time budget \(1s\) exhausted after 2 lookups/);
});

test('ordering: newest updatedAt first (publishedAt fallback); name then version break ties by plain comparison', async () => {
  const mk = (name, meta, version = '1.0.0') => ({ ...npmRow(name, meta), server: { ...npmRow(name).server, version } });
  const rows = [
    mk('io.github.acme/b', { updatedAt: '2026-10-01T00:00:00Z' }),
    mk('io.github.acme/a', { updatedAt: '2026-10-01T00:00:00Z' }),
    mk('io.github.acme/c', { publishedAt: '2026-10-20T00:00:00Z' }),
    mk('io.github.acme/zeta', { updatedAt: '2026-09-01T00:00:00Z' }),
    mk('io.github.acme/old', {}),
  ];
  const res = await sync(rows, { max: 10, maxPerPublisher: 50 });
  assert.deepEqual(res.accepted.map(a => a.plan.officialName), ['io.github.acme/c', 'io.github.acme/a', 'io.github.acme/b', 'io.github.acme/zeta', 'io.github.acme/old']);
  const again = await sync([...rows].reverse(), { max: 10, maxPerPublisher: 50 });
  assert.deepEqual(again.accepted.map(a => a.plan.officialName), res.accepted.map(a => a.plan.officialName));
  assert.match(res.body, /To permanently decline a candidate, add it to the denylist; closing this PR does not\./);
});

test('total byte cap fails closed', async () => {
  let n = 0;
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(npmPage(`t${n++}`)), maxTotalBytes: 1500, maxPages: 1e6, maxRawRows: 1e9 }), /total byte cap \(1500\) exceeded/);
  assert.equal(LIMITS.maxTotalBytes, 1024 ** 3);
});

const npmPage = tag => ({ servers: [npmRow(`io.github.a/${tag}`)], metadata: { nextCursor: `c-${tag}` } });
const skippedPage = tag => ({ servers: Array.from({ length: 50 }, (_, i) => ({ server: { $schema: 'https://evil.example/s.json', name: `io.github.s/${tag}-${i}`, version: '1' } })), metadata: { nextCursor: `s-${tag}` } });

test('an endless all-skipped feed hits the raw cap cleanly; skipped is counted but only listed up to the cap', async () => {
  let n = 0;
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(skippedPage(n++)), maxRawRows: 400, maxPages: 1e6 }), /raw row cap \(400\) exceeded/);
  assert.ok(n <= 9);
  let k = 0;
  const out = await fetchAll({ fetchImpl: async () => jsonRes(k < 5 ? { ...skippedPage(k++) } : { servers: [], metadata: {} }), maxRawRows: 1e6 });
  assert.equal(out.skippedCount, 250);
  assert.equal(out.skipped.length, LIMITS.maxSkippedKept);
  assert.equal(out.rawRows, 250);
});

test('time-budget error carries the underlying cause', async () => {
  await assert.rejects(fetchAll({ budgetMs: 100, nowImpl: (() => { let t = 0; return () => (t += 60); })(), fetchImpl: async () => { throw new Error('socket hang up'); } }), /time budget \(0\.1s|time budget \(\d+s\).*socket hang up|socket hang up/);
});

test('ordering: a future-dated row (more than a day ahead) does not sort first', async () => {
  const rows = [
    npmRow('io.github.acme/future', { updatedAt: '2099-01-01T00:00:00Z' }),
    npmRow('io.github.acme/recent', { updatedAt: '2026-11-07T00:00:00Z' }),
    npmRow('io.github.acme/soon', { updatedAt: '2026-11-08T12:00:00Z' }), // within one day of NOW: still honoured
  ];
  const res = await sync(rows, { max: 10, maxPerPublisher: 50 });
  assert.deepEqual(res.accepted.map(a => a.plan.officialName), ['io.github.acme/soon', 'io.github.acme/recent', 'io.github.acme/future']);
});

test('byte counting uses real bytes, not string length (multibyte text)', async () => {
  const body = JSON.stringify({ servers: [], metadata: { nextCursor: '', note: 'é'.repeat(100) } });
  const { getJson } = await import('../sync-official/fetch-official.mjs');
  const r = await getJson('https://x.test/', { fetchImpl: async () => new Response(body) });
  assert.equal(r.bytes, Buffer.byteLength(body));
  assert.ok(r.bytes > body.length);
});

test('budget race: a clamped request aborted just before the clock reaches the budget reports the time budget', async () => {
  const frozen = () => 0; // the clock never reaches the budget, as when the abort fires ~1 ms early
  for (const make of [() => new DOMException('The operation was aborted due to timeout', 'TimeoutError'), () => new Error('aborted')]) {
    await assert.rejects(fetchAll({ budgetMs: 1000, nowImpl: frozen, fetchImpl: async () => { throw make(); } }), /time budget \(1s\) exhausted.*\(/);
  }
  // not clamped (plenty of budget left): an abort/timeout is the request's own failure and is surfaced as is
  await assert.rejects(fetchAll({ budgetMs: 10 * 60_000, nowImpl: frozen, fetchImpl: async () => { throw new Error('aborted'); } }), /^Error: aborted$/);
  // a clamped request failing for another reason is not mislabelled
  await assert.rejects(fetchAll({ budgetMs: 1000, nowImpl: frozen, fetchImpl: async () => new Response('x', { status: 500 }) }), /HTTP 500/);
});
