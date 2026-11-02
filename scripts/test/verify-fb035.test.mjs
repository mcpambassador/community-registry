// Verifier edge tests for community-registry #24 (FB-035/036, TD-056/057). Independent of the builder's tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import yaml from '../lib/yaml.mjs';
import { OFFICIAL_META_KEY } from '../sync-official/eligibility.mjs';
import { ALLOWED_SCHEMAS } from '../sync-official/fetch-official.mjs';
import { runSync } from '../sync-official/sync.mjs';
import { githubRepoOf, scoreRepo, fetchRepoMeta } from '../sync-official/repo-meta.mjs';
import { labelsFor } from '../ci/label-category.mjs';
import { makeValidator } from '../sync-official/schema-validate.mjs';

const SCHEMA = [...ALLOWED_SCHEMAS][0];
const registryText = fs.readFileSync(new URL('../../registry.yaml', import.meta.url), 'utf8');
const top = JSON.parse(fs.readFileSync(new URL('../sync-official/top-packages.json', import.meta.url), 'utf8'));
const validate = makeValidator();
const NOW = '2026-11-08T00:00:00Z';
const NOWMS = Date.parse(NOW);
const DAY = 86_400_000;
const row = (owner, day) => ({
  server: { $schema: SCHEMA, version: '1.0.0', description: 'd', name: `io.github.${owner}/t`, repository: { url: `https://github.com/${owner}/r` }, packages: [{ registryType: 'npm', identifier: `${owner}-mcp`, version: '1.2.3', transport: { type: 'stdio' } }] },
  _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true, updatedAt: `2026-11-0${day}T00:00:00Z` } },
});
const okLookup = async () => ({ ok: true, dependenciesPinned: false, flags: ['dependencies-unpinned'], packageIntegrity: { npm: 'sha512-AAAA' } });
const M = (stars, o = {}) => ({ meta: { stars, archived: false, pushedAt: NOWMS - DAY, createdAt: NOWMS - 400 * DAY, ...o } });
const sync = (rows, repoMeta, o = {}) => runSync({ registryText, rows, now: NOW, lookup: okLookup, validate, deny: { names: [], packages: [] }, top, repoMeta, ...o });

// ---- monthly full-scan trigger: run the REAL shell lines from the workflow for every day of a month ----
const wf = yaml.load(fs.readFileSync(new URL('../../.github/workflows/sync-official-registry.yml', import.meta.url), 'utf8'));
const run = wf.jobs.prepare.steps.find(s => s.id === 'sync').run;
const shellLines = run.split('\n').filter(l => /^\s*(flags=|if \[)/.test(l) || /^\s*case/.test(l)).join('\n');
function flagsFor(event, dryRun, fullScan, day) {
  // stub `date` so day-of-month is controllable (incl. zero-padded 08/09, which break naive octal arithmetic)
  const script = `date() { echo "${day}"; }\n${shellLines}\necho "FLAGS=[$flags]"`;
  const out = execFileSync('bash', ['-c', script], { env: { EVENT_NAME: event, DRY_RUN: dryRun, FULL_SCAN: fullScan, MAX_PER_PUBLISHER: '2', PATH: process.env.PATH }, encoding: 'utf8' });
  return /FLAGS=\[(.*)\]/.exec(out)[1].trim().split(/\s+/).filter(Boolean);
}
test('schedule: full scan exactly on day-of-month 01..07 (incl. 08/09 octal trap); always --dry-run', () => {
  for (let d = 1; d <= 31; d++) {
    const dd = String(d).padStart(2, '0');
    const f = flagsFor('schedule', '', '', dd);
    assert.ok(f.includes('--dry-run'), `day ${dd} dry-run`);
    assert.equal(f.includes('--full-scan'), d <= 7, `day ${dd} full-scan`);
  }
});
test('schedule with hostile/odd empty inputs still dry-run; dispatch never gets the monthly full scan from the date', () => {
  assert.deepEqual(flagsFor('schedule', 'false', '', '03'), ['--dry-run', '--full-scan']);
  assert.deepEqual(flagsFor('workflow_dispatch', 'false', 'false', '03'), []);
  assert.deepEqual(flagsFor('workflow_dispatch', 'true', 'false', '20'), ['--dry-run']);
  assert.deepEqual(flagsFor('workflow_dispatch', 'true', 'true', '20'), ['--dry-run', '--full-scan']);
  assert.deepEqual(flagsFor('workflow_dispatch', 'false', 'true', '20'), ['--full-scan']);
});
test('open-pr: schedule cannot reach it (GitHub expression: null == false is true, so the event guard must be what blocks)', () => {
  const cond = wf.jobs['open-pr'].if;
  assert.match(cond, /^\s*(\$\{\{)?\s*github\.event_name == 'workflow_dispatch' &&/);
  assert.ok(wf.jobs['open-pr'].environment, 'environment gate kept');
  assert.equal(wf.on.schedule.length, 1);
});

// ---- repo-meta score boundaries ----
test('scoreRepo boundaries: 365d push ok, >365d stale; 180d age bonus exact; 0 stars finite', () => {
  assert.ok(scoreRepo(M(0, { pushedAt: NOWMS - 365 * DAY }).meta, NOWMS).score >= 0);
  assert.deepEqual(scoreRepo(M(0, { pushedAt: NOWMS - 365 * DAY - 1 }).meta, NOWMS), { reject: 'repo-stale' });
  const a = scoreRepo(M(10, { createdAt: NOWMS - 180 * DAY }).meta, NOWMS).score;
  const b = scoreRepo(M(10, { createdAt: NOWMS - 180 * DAY + 1 }).meta, NOWMS).score;
  assert.ok(Math.abs(a - b - 0.5) < 1e-9);
  assert.ok(Number.isFinite(scoreRepo(M(0).meta, NOWMS).score));
  assert.deepEqual(scoreRepo(M(99999, { archived: true }).meta, NOWMS), { reject: 'repo-archived' }); // archived wins over stars
});
test('future pushed_at / created_at do not crash or reject', () => {
  const r = scoreRepo(M(5, { pushedAt: NOWMS + 400 * DAY, createdAt: NOWMS + DAY }).meta, NOWMS);
  assert.ok(Number.isFinite(r.score));
});

// ---- fail-soft + cap through runSync ----
test('403 non-ratelimit, 5xx, thrown fetch: candidate deferred, run continues, no accept, no throw', async () => {
  const rows = [row('a', 7), row('b', 6), row('c', 5)];
  const res = await sync(rows, async o => o === 'a' ? { error: 'unavailable' } : o === 'b' ? { error: 'not-found' } : M(3), { max: 10 });
  assert.deepEqual(res.accepted.map(a => a.plan.officialName), ['io.github.c/t']);
  assert.equal(res.scope.repoStats.unavailable, 2);
  assert.equal(res.scope.repoStats.rateLimited, false);
});
test('rate-limit: no further calls after the limit; later GitHub candidates stay unscored (N2) and candidates without a repo still pass', async () => {
  const noRepo = row('zz', 8); delete noRepo.server.repository;
  let calls = 0;
  const res = await sync([noRepo, row('a', 7), row('b', 6)], async () => { calls++; return { error: 'rate-limited' }; }, { max: 10 });
  assert.equal(calls, 1);
  assert.deepEqual(res.accepted.map(a => a.plan.officialName), ['io.github.zz/t', 'io.github.a/t', 'io.github.b/t']);
});
test('lookup cap enforced: metadata calls <= maxLookups and accepted lookups <= maxLookups with 30 candidates', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`o${i}`, (i % 7) + 1));
  let calls = 0, looked = 0;
  const res = await sync(rows, async () => { calls++; return M(5); }, { max: 50, maxLookups: 4, maxPerPublisher: 5, lookup: async (...a) => { looked++; return okLookup(...a); } });
  assert.ok(calls <= 4, `meta calls ${calls}`);
  assert.ok(looked <= 4, `lookups ${looked}`);
  assert.ok(res.accepted.length <= 4);
});
test('F1: rejected rows use up the check cap; a candidate past it is never accepted unchecked', async () => {
  const rows = [row('dead', 7), row('stale', 6), row('ok', 5)];
  let looked = 0;
  const meta = o => o === 'dead' ? M(1, { archived: true }) : o === 'stale' ? M(1, { pushedAt: NOWMS - 400 * DAY }) : M(1);
  const res = await sync(rows, async o => meta(o), { max: 10, maxLookups: 1, lookup: async (...a) => { looked++; return okLookup(...a); } });
  assert.equal(looked, 0);
  assert.deepEqual(res.accepted.map(a => a.plan.officialName), [], 'never stale, never unchecked');
  const refilled = await sync(rows, async o => meta(o), { max: 10, maxLookups: 3, lookup: okLookup });
  assert.deepEqual(refilled.accepted.map(a => a.plan.officialName), ['io.github.ok/t']);
});
test('tier still dominates score; hostile repo URL is not fetched', async () => {
  const evil = row('evil', 7); evil.server.repository.url = 'https://github.com/a/..%2f..%2fadmin';
  const seen = [];
  await sync([evil, row('a', 6)], async (o, r) => { seen.push(`${o}/${r}`); return M(1); }, { max: 10 });
  assert.deepEqual(seen, ['a/r']);
});
test('fetchRepoMeta: redirect response (3xx), oversize body, abort all map to unavailable; token not sent for invalid names', async () => {
  const seen = [];
  const f = (status, text = '{}') => async (u, o) => { seen.push(o); return new Response(text, { status }); };
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: f(301) }), { error: 'unavailable' });
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: f(200, 'x'.repeat(300 * 1024)) }), { error: 'unavailable' });
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: async () => { throw new DOMException('t', 'TimeoutError'); } }), { error: 'unavailable' });
  const n = seen.length;
  await fetchRepoMeta('a\nb', 'c', { token: 'T', fetchImpl: f(200) });
  assert.equal(seen.length, n);
  assert.equal(githubRepoOf('https://GitHub.com/A/B')?.owner, 'A'); // hostname lowercased by URL
});

// ---- label-category (TD-056) ----
test('labelsFor: prototype keys and junk are ignored; always registry-pr', () => {
  assert.deepEqual(labelsFor(null), ['registry-pr']);
  assert.deepEqual(labelsFor({ mcps: [{ category: '__proto__', transport_type: 'constructor', auth_type: 'toString' }, null, 5] }), ['registry-pr']);
  assert.ok(labelsFor({ mcps: [{ category: 'Security', transport_type: 'http', auth_type: 'oauth2', verified: true }] }).includes('verified-entry'));
});
test('label workflow runs script from BASE and never pull_request_target', () => {
  const t = fs.readFileSync(new URL('../../.github/workflows/label-category.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(t, /pull_request_target:/);
  assert.match(t, /label-category\.mjs/);
});
