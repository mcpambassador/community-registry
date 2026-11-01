// FB-034 verifier edge cases: caps, all-unverified feed, watermark robustness, domain matching, CLI/workflow input validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OFFICIAL_META_KEY, publisherTier, evaluate, hostMatchesDomain } from '../sync-official/eligibility.mjs';
import { ALLOWED_SCHEMAS } from '../sync-official/fetch-official.mjs';
import { runSync, deriveWatermark } from '../sync-official/sync.mjs';
import { makeValidator } from '../sync-official/schema-validate.mjs';

const SCHEMA = [...ALLOWED_SCHEMAS][0];
const registryText = fs.readFileSync(new URL('../../registry.yaml', import.meta.url), 'utf8');
const top = JSON.parse(fs.readFileSync(new URL('../sync-official/top-packages.json', import.meta.url), 'utf8'));
const validate = makeValidator();
const NOW = '2026-11-08T00:00:00Z';
const NOWMS = Date.parse(NOW);
const row = (server, meta = {}) => ({ server: { $schema: SCHEMA, version: '1.0.0', description: 'd', ...server }, _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true, ...meta } } });
const npmRow = (name, meta = {}) => row({ name, packages: [{ registryType: 'npm', identifier: name.split('/')[1] + '-mcp', version: '1.2.3', transport: { type: 'stdio' } }] }, meta);
const remoteRow = (name, url) => row({ name, remotes: [{ type: 'streamable-http', url }] });
const okLookup = async plan => (plan.kind === 'remote' ? { ok: true, flags: [] } : { ok: true, dependenciesPinned: false, flags: ['dependencies-unpinned'], packageIntegrity: { npm: 'sha512-AAAA' } });
const sync = (rows, over = {}) => runSync({ registryText, rows, now: NOW, lookup: okLookup, validate, deny: { names: [], packages: [] }, top, ...over });
const names = res => res.accepted.map(a => a.plan.officialName);
const ctx = { takenSlugs: new Set(), existingOfficialNames: new Set(), knownSlugs: new Set(), knownPackages: new Set(), denyNames: new Set(), denyPackages: new Set() };
const reg = t => `mcps:\n${t.map(([s, at], i) => `- name: m${i}\n  source: ${s}\n  synced_at: ${at}\n`).join('')}`;

test('publisher with 5 candidates is capped to 2 (default), newest two win, 3 held back and counted deferred', async () => {
  const rows = [1, 2, 3, 4, 5].map(i => npmRow(`io.github.big/t${i}`, { updatedAt: `2026-11-0${i}T00:00:00Z` }));
  const res = await sync(rows, { max: 10 });
  assert.deepEqual(names(res), ['io.github.big/t5', 'io.github.big/t4']);
  assert.equal(res.scope.cappedByPublisher, 3);
  assert.equal(res.deferred, 3);
  assert.equal(res.lookups, 2, 'capped candidates must not cost a network lookup');
});

test('cap applies per namespace, not across tiers: a domain publisher with 5 npm rows is capped too', async () => {
  const rows = [1, 2, 3, 4, 5].map(i => npmRow(`com.acme/t${i}`, { updatedAt: `2026-11-0${i}T00:00:00Z` }));
  const res = await sync(rows, { max: 10 });
  assert.equal(res.accepted.length, 2);
  assert.equal(res.scope.publishers, 1);
});

test('all-unverified feed: nothing tier 1, still proposes (capped), no crash', async () => {
  const rows = ['com.a', 'com.b', 'com.c'].flatMap(ns => [1, 2, 3].map(i => npmRow(`${ns}/t${i}`)));
  const res = await sync(rows, { max: 10 });
  assert.deepEqual(res.scope.tierCounts, { 1: 0, 2: 9 });
  assert.deepEqual(res.scope.acceptedTiers, { 1: 0, 2: 6 });
  assert.equal(res.scope.publishers, 3);
  assert.match(res.body, /0 github-or-host-matched, 9 other/);
});

test('empty feed: zero accepted, scope all zeros, body renders', async () => {
  const res = await sync([]);
  assert.equal(res.accepted.length, 0);
  assert.deepEqual(res.scope.tierCounts, { 1: 0, 2: 0 });
  assert.equal(res.scope.publishers, 0);
});

test('max smaller than cap still wins', async () => {
  const rows = [1, 2, 3].map(i => npmRow(`io.github.big/t${i}`, { updatedAt: `2026-11-0${i}T00:00:00Z` }));
  assert.equal((await sync(rows, { max: 1, maxPerPublisher: 5 })).accepted.length, 1);
});

test('namespaces differing only in case are one publisher', async () => {
  const rows = [1, 2, 3, 4].map(i => npmRow(`io.github.${i % 2 ? 'Big' : 'big'}/t${i}`, { updatedAt: `2026-11-0${i}T00:00:00Z` }));
  const res = await sync(rows, { max: 10 });
  assert.ok(res.accepted.length <= 2, `cap bypassed via case: accepted ${names(res).join(', ')}`);
});

test('watermark: missing or corrupt synced_at on official entries -> undefined (full scan)', () => {
  for (const bad of ['', 'null', 'garbage', '"2026-13-45T99:99:99Z"', '{a: 1}']) {
    assert.equal(deriveWatermark(reg([['official-registry', bad]]), NOWMS), undefined, `bad stamp ${bad}`);
  }
  assert.equal(deriveWatermark('mcps:\n- name: x\n  source: official-registry\n', NOWMS), undefined, 'no synced_at key');
  assert.equal(deriveWatermark('', NOWMS), undefined, 'empty file');
});

test('watermark: mcps that is not an array -> undefined', () => {
  assert.equal(deriveWatermark('mcps: {}\n', NOWMS), undefined);
});

test('watermark: unquoted YAML timestamp (js-yaml Date object) is understood', () => {
  const wm = deriveWatermark(reg([['official-registry', '2026-11-01T06:00:00Z']]), NOWMS);
  assert.equal(wm, '2026-10-31T06:00:00Z');
});

test('watermark: corrupt YAML throws rather than silently yielding a bogus watermark', () => {
  assert.throws(() => deriveWatermark('mcps: [unclosed\n  - : :', NOWMS));
});

test('watermark: future-dated entries are ignored, a valid older one still counts; never later than now', () => {
  const wm = deriveWatermark(reg([['official-registry', '2099-01-01T00:00:00Z'], ['official-registry', '2026-10-01T00:00:00Z']]), NOWMS);
  assert.equal(wm, '2026-09-30T00:00:00Z');
  assert.ok(Date.parse(wm) < NOWMS);
  assert.equal(deriveWatermark(reg([['official-registry', '2099-01-01T00:00:00Z']]), NOWMS), undefined);
  // exactly "now" is allowed, a second later is not
  assert.equal(deriveWatermark(reg([['official-registry', NOW]]), NOWMS), '2026-11-07T00:00:00Z');
  assert.equal(deriveWatermark(reg([['official-registry', '2026-11-08T00:00:01Z']]), NOWMS), undefined);
});

test('watermark: output is second-precision ISO Z (safe for the query string)', () => {
  assert.match(deriveWatermark(reg([['official-registry', '2026-11-01T06:00:00.123Z']]), NOWMS), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('domain match: dot-suffix only, case-insensitive, port and userinfo irrelevant', () => {
  const tier = (n, u) => publisherTier(evaluate(remoteRow(n, u), ctx).plan);
  assert.equal(tier('com.example/a', 'https://evil-example.com/mcp'), 2, 'evil-example.com must not match com.example');
  assert.equal(tier('com.example/a', 'https://example.com.evil.com/mcp'), 2);
  assert.equal(tier('com.example/a', 'https://notexample.com/mcp'), 2);
  assert.equal(evaluate(remoteRow('com.example/a', 'https://example.com@evil.com/mcp'), ctx).ok, false, 'userinfo URLs are rejected outright');
  assert.equal(tier('com.example/a', 'https://evil.com/example.com'), 2, 'domain in path');
  assert.equal(tier('com.example/a', 'https://example.com/mcp'), 1);
  assert.equal(tier('com.example/a', 'https://api.example.com/mcp'), 1);
  assert.equal(tier('com.example/a', 'https://API.Example.COM:8443/mcp'), 1, 'case + port');
  assert.equal(tier('com.Example/a', 'https://api.example.com/mcp'), 1, 'case in namespace');
  assert.equal(tier('com.example/a', 'https://example.com./mcp'), 2, 'trailing-dot FQDN falls to tier 2 (conservative, fail-safe)');
});

test('hostMatchesDomain unit: empty / degenerate inputs never match', () => {
  assert.equal(hostMatchesDomain('', 'example.com'), false);
  assert.equal(hostMatchesDomain('com', 'example.com'), false);
});

test('CLI: --max-per-publisher rejects 0, 51, 1.5, abc, empty; accepts 1 and 50', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb034-'));
  const rows = path.join(dir, 'rows.json');
  fs.writeFileSync(rows, '[]');
  const run = v => spawnSync(process.execPath, ['scripts/sync-official/sync.mjs', '--out', path.join(dir, 'o'), '--rows-file', rows, '--dry-run', '--max-per-publisher', v], { encoding: 'utf8' });
  for (const bad of ['0', '51', '1.5', 'abc', '-1', '']) {
    const r = run(bad);
    assert.notEqual(r.status, 0, `--max-per-publisher "${bad}" should fail`);
    assert.match(r.stderr, /--max-per-publisher must be 1\.\.50/, bad);
  }
  for (const good of ['1', '50']) assert.equal(run(good).status, 0, `${good}: ${run(good).stderr}`);
});

test('CLI: --full-scan suppresses the watermark', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb034-'));
  const rows = path.join(dir, 'rows.json');
  fs.writeFileSync(rows, '[]');
  const r = spawnSync(process.execPath, ['scripts/sync-official/sync.mjs', '--out', path.join(dir, 'o'), '--rows-file', rows, '--dry-run', '--full-scan'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /scan: full/);
});

test('workflow: new inputs reach the shell only via env, never interpolated into run:', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/sync-official-registry.yml', import.meta.url), 'utf8');
  const runBlocks = wf.split(/\n\s*run: /).slice(1).map(b => b.split('\n      - ')[0]);
  for (const b of runBlocks) assert.doesNotMatch(b, /\$\{\{\s*inputs\./, 'inputs interpolated into run block');
  assert.match(wf, /MAX_PER_PUBLISHER: \$\{\{ inputs\.max_per_publisher \}\}/);
  assert.match(wf, /FULL_SCAN: \$\{\{ inputs\.full_scan \}\}/);
  assert.match(wf, /full_scan:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(wf, /max_per_publisher:[\s\S]*?type: number[\s\S]*?default: 2/);
});
