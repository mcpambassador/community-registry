import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluate, cheapDrop, OFFICIAL_META_KEY } from '../sync-official/eligibility.mjs';
import { LIMITS, fetchAll, ALLOWED_SCHEMAS } from '../sync-official/fetch-official.mjs';

const SCHEMA = [...ALLOWED_SCHEMAS][0];
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/official-rows.json', import.meta.url), 'utf8'));
const row = (server, meta = {}) => ({ server: { $schema: SCHEMA, version: '1.0.0', description: 'd', ...server }, _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true, ...meta } } });
const npmPkg = (over = {}) => ({ registryType: 'npm', identifier: 'thing-mcp', version: '1.2.3', transport: { type: 'stdio' }, ...over });
const page = (names, nextCursor = '') => ({ servers: names.map(n => row({ name: n, packages: [npmPkg()] })), metadata: { nextCursor, count: names.length } });
const jsonRes = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

test('bounds: an endless feed (always a fresh cursor and fresh rows) hits the page cap', async () => {
  let n = 0;
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(page([`io.github.a/p${n++}`], `c${n}`)), maxPages: 25, maxRawRows: 1e9 }), /page cap \(25\) reached/);
  assert.equal(n, 25);
});

test('bounds: too many raw rows hits the raw cap even when every row is dropped early', async () => {
  let n = 0;
  const names = () => Array.from({ length: 50 }, () => `io.github.a/r${n++}`);
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(page(names(), `c${n}`)), keep: () => 'x', maxRawRows: 120, maxPages: 1e6 }), /raw row cap \(120\) exceeded/);
});

test('bounds: slow pages exhaust the wall-clock budget between requests', async () => {
  let t = 0;
  let n = 0;
  await assert.rejects(fetchAll({ fetchImpl: async () => { t += 300; return jsonRes(page([`io.github.a/s${n++}`], `s${n}`)); }, nowImpl: () => t, budgetMs: 1000, maxPages: 1e6 }), /time budget \(1s\) exhausted/);
  assert.ok(n <= 4);
});

test('bounds: a request that hangs is aborted by the remaining budget, not the 15s per-request timeout', async () => {
  const keepAlive = setInterval(() => {}, 10);
  const t0 = Date.now();
  let seenSignal;
  try {
    await assert.rejects(fetchAll({
      budgetMs: 200,
      fetchImpl: (u, o) => new Promise((_, rej) => { seenSignal = o.signal; o.signal.addEventListener('abort', () => rej(new Error('aborted'))); }),
    }), /time budget/);
  } finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  assert.ok(LIMITS.timeoutMs > 200 && seenSignal.aborted);
});

test('bounds: per-request timeout never exceeds the remaining budget (later request after budget mostly spent)', async () => {
  const keepAlive = setInterval(() => {}, 10);
  let t = 0;
  let calls = 0;
  const t0 = Date.now();
  try {
    await assert.rejects(fetchAll({
      budgetMs: 1000, nowImpl: () => t,
      fetchImpl: (u, o) => {
        if (calls++ === 0) { t = 950; return Promise.resolve(jsonRes(page(['io.github.a/z'], 'z1'))); } // 50ms of budget left
        return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      },
    }), /aborted|time budget/);
  } finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - t0 < 1000, `abort took ${Date.now() - t0}ms; should be ~50ms, not 15s`);
});

test('bounds: a page over 5 MB is rejected through fetchAll (streamed and declared)', async () => {
  const big = 'x'.repeat(LIMITS.maxBytes + 1);
  await assert.rejects(fetchAll({ fetchImpl: async () => new Response(big) }), /too large/);
  await assert.rejects(fetchAll({ fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(LIMITS.maxBytes + 1) } }) }), /too large/);
});

// ---- cheapDrop / evaluate agreement ----
const base = () => ({ name: 'io.github.acme/thing', packages: [npmPkg()] });
const variants = [];
for (const meta of [{}, { status: 'deprecated' }, { status: 'deleted' }, { status: undefined }, { isLatest: false }, { isLatest: undefined }]) {
  for (const server of [
    base(), { name: 'no-namespace', packages: [npmPkg()] }, { name: 'io.github.acme/thing' }, { name: 'io.github.acme/thing', packages: [] },
    { name: 'io.github.acme/thing', packages: [{ registryType: 'oci', identifier: 'x', version: '1', transport: { type: 'stdio' } }] },
    { name: 'io.github.acme/thing', packages: [npmPkg(), npmPkg({ identifier: 'other' })] },
    { name: 'io.github.acme/thing', packages: [npmPkg()], remotes: [{ type: 'streamable-http', url: 'https://x.acme.com/mcp' }] },
    { name: 'com.acme/thing', remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.com/mcp' }] },
    { name: 'com.acme/thing', remotes: [{ type: 'sse', url: 'https://mcp.acme.com/mcp' }] },
    { name: 'io.github.acme/thing', packages: [npmPkg({ transport: { type: 'http' } })] },
    { name: 'io.github.acme/thing', packages: [npmPkg({ identifier: 'bad name!' })] },
    { name: 'io.github.acme/thing', packages: [npmPkg({ version: '^1.0.0' })] },
  ]) variants.push(row(server, meta));
}
const ctxs = [
  { denyNames: new Set(), existingOfficialNames: new Set() },
  { denyNames: new Set(['io.github.acme/thing']), existingOfficialNames: new Set() },
  { denyNames: new Set(), existingOfficialNames: new Set(['io.github.acme/thing', 'com.acme/thing']) },
].map(c => ({ takenSlugs: new Set(), knownSlugs: new Set(), knownPackages: new Set(), denyPackages: new Set(), ...c }));

test('cheapDrop/evaluate agree over fixtures and mutated rows: never drops what evaluate accepts; same reason when it drops', () => {
  const rows = [...fixtures, ...variants];
  let accepted = 0, dropped = 0;
  for (const c of ctxs) for (const r of rows) {
    const cd = cheapDrop(r, c);
    const ev = evaluate(r, c);
    if (ev.ok) { assert.equal(cd.ok, true, `cheapDrop dropped an evaluate-accepted row: ${r.server.name} (${cd.reason})`); accepted++; }
    if (!cd.ok) { assert.equal(ev.ok, false); assert.equal(ev.reason, cd.reason); assert.equal(ev.detail, cd.detail); dropped++; }
  }
  assert.ok(accepted > 0 && dropped > 0, `accepted=${accepted} dropped=${dropped}`);
});

test('cheapDrop with the reduced context sync.mjs passes (no slug state) agrees with the full-context evaluate', () => {
  for (const full of ctxs) {
    const early = { denyNames: full.denyNames, existingOfficialNames: full.existingOfficialNames };
    for (const r of [...fixtures, ...variants]) {
      const cd = cheapDrop(r, early);
      if (evaluate(r, full).ok) assert.equal(cd.ok, true, r.server.name);
    }
  }
});
