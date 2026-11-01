import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OFFICIAL_META_KEY } from '../sync-official/eligibility.mjs';
import { LIMITS, fetchAll, ALLOWED_SCHEMAS } from '../sync-official/fetch-official.mjs';
import { runSync } from '../sync-official/sync.mjs';
import { makeValidator } from '../sync-official/schema-validate.mjs';

const SCHEMA = [...ALLOWED_SCHEMAS][0];
const registryText = fs.readFileSync(new URL('../../registry.yaml', import.meta.url), 'utf8');
const top = JSON.parse(fs.readFileSync(new URL('../sync-official/top-packages.json', import.meta.url), 'utf8'));
const jsonRes = obj => new Response(JSON.stringify(obj), { status: 200 });
const npmRow = i => ({ server: { $schema: SCHEMA, name: `io.github.adv${i}/thing`, version: '1.0.0', description: 'd', packages: [{ registryType: 'npm', identifier: `adv-mcp-${i}`, version: '1.2.3', transport: { type: 'stdio' } }] }, _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true } } });

test('adversarial: every lookup fails, max=10 → at most 50 lookups, rest deferred, clean result', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => npmRow(i));
  let calls = 0;
  const res = await runSync({ registryText, rows, max: 10, now: '2026-11-08T00:00:00Z', validate: makeValidator(), deny: {}, top, lookup: async () => { calls++; throw new Error('index down'); } });
  assert.ok(calls <= 50, `lookups=${calls}`);
  assert.equal(res.lookups, calls);
  assert.equal(res.accepted.length, 0);
  assert.equal(res.eligible, 500);
  assert.equal(res.deferred, 500 - calls);
  assert.match(res.body, /deferred/i);
});

test('adversarial: endless all-skipped feed fails closed at default caps with a clean error, bounded memory', async () => {
  let n = 0;
  const before = process.memoryUsage().heapUsed;
  const bad = () => Array.from({ length: 100 }, () => ({ server: { $schema: 'https://evil.example/s.json', name: `x/${n++}`, version: '1' } }));
  await assert.rejects(
    fetchAll({ fetchImpl: async () => jsonRes({ servers: bad(), metadata: { nextCursor: `c${n}` } }), log: () => {} }),
    e => e instanceof Error && /raw row cap|page cap/.test(e.message),
  );
  assert.ok(n <= LIMITS.maxRawRows + 100);
  assert.ok(process.memoryUsage().heapUsed - before < 200 * 1048576, 'heap growth bounded');
});

test('adversarial: skipped list is capped, but the count is exact', async () => {
  let p = 0;
  const out = await fetchAll({ fetchImpl: async () => jsonRes({ servers: Array.from({ length: 100 }, () => ({ server: { $schema: 'https://evil.example/s.json', name: 'x', version: '1' } })), metadata: { nextCursor: ++p < 5 ? `c${p}` : '' } }), log: () => {} });
  assert.equal(out.skippedCount, 500);
  assert.equal(out.skipped.length, LIMITS.maxSkippedKept);
});

test('adversarial: cumulative byte cap fails closed', async () => {
  let n = 0;
  await assert.rejects(fetchAll({ maxTotalBytes: 3000, fetchImpl: async () => jsonRes({ servers: [{ server: { $schema: SCHEMA, name: `io.github.a/b${n++}`, version: '1', description: 'y'.repeat(900) } }], metadata: { nextCursor: `c${n}` } }), log: () => {} }), /total byte cap/);
});
