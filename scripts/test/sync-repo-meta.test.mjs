// FB-036: GitHub repository quality signal (ranking, rejections, fail-soft, input validation).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OFFICIAL_META_KEY } from '../sync-official/eligibility.mjs';
import { ALLOWED_SCHEMAS } from '../sync-official/fetch-official.mjs';
import { runSync } from '../sync-official/sync.mjs';
import { githubRepoOf, parseRepoMeta, scoreRepo, fetchRepoMeta } from '../sync-official/repo-meta.mjs';
import { makeValidator } from '../sync-official/schema-validate.mjs';

const SCHEMA = [...ALLOWED_SCHEMAS][0];
const registryText = fs.readFileSync(new URL('../../registry.yaml', import.meta.url), 'utf8');
const top = JSON.parse(fs.readFileSync(new URL('../sync-official/top-packages.json', import.meta.url), 'utf8'));
const validate = makeValidator();
const NOW = '2026-11-08T00:00:00Z';
const NOWMS = Date.parse(NOW);
const DAY = 86_400_000;
const iso = ms => new Date(ms).toISOString();
const ghRow = (owner, day, repoUrl = `https://github.com/${owner}/r`) => ({
  server: { $schema: SCHEMA, version: '1.0.0', description: 'd', name: `io.github.${owner}/t`, repository: { url: repoUrl }, packages: [{ registryType: 'npm', identifier: `${owner}-mcp`, version: '1.2.3', transport: { type: 'stdio' } }] },
  _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true, updatedAt: `2026-11-0${day}T00:00:00Z` } },
});
const okLookup = async () => ({ ok: true, dependenciesPinned: false, flags: ['dependencies-unpinned'], packageIntegrity: { npm: 'sha512-AAAA' } });
const meta = (stars, over = {}) => ({ meta: { stars, archived: false, pushedAt: NOWMS - 10 * DAY, createdAt: NOWMS - 400 * DAY, ...over } });
const sync = (rows, repoMeta, over = {}) => runSync({ registryText, rows, now: NOW, lookup: okLookup, validate, deny: { names: [], packages: [] }, top, repoMeta, ...over });
const names = res => res.accepted.map(a => a.plan.officialName);

test('githubRepoOf: only plain github.com/<owner>/<repo> URLs; anything else is undefined', () => {
  assert.deepEqual(githubRepoOf('https://github.com/acme/tool'), { owner: 'acme', repo: 'tool' });
  assert.deepEqual(githubRepoOf('https://github.com/acme/tool.git'), { owner: 'acme', repo: 'tool' });
  assert.deepEqual(githubRepoOf('https://github.com/acme/tool/'), { owner: 'acme', repo: 'tool' });
  for (const bad of ['http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com.evil.com/a/b', 'https://x@github.com/a/b', 'https://github.com/a', 'https://github.com/a/b/c',
    'https://github.com/a/b?x=1', 'https://github.com/a/b#f', 'https://github.com/a/%2e%2e', 'https://github.com/../b', 'https://github.com/a/b%2fc', 'https://github.com/a b/c', '', undefined, 42]) {
    assert.equal(githubRepoOf(bad), undefined, String(bad));
  }
});

test('parseRepoMeta: untrusted numbers and types are validated', () => {
  const good = { stargazers_count: 5, archived: false, pushed_at: '2026-10-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z' };
  assert.equal(parseRepoMeta(good).stars, 5);
  for (const bad of [{ ...good, stargazers_count: -1 }, { ...good, stargazers_count: 1.5 }, { ...good, stargazers_count: '5' }, { ...good, stargazers_count: 1e12 }, { ...good, archived: 'false' },
    { ...good, pushed_at: 'nope' }, { ...good, created_at: undefined }, null, [], 'x']) assert.equal(parseRepoMeta(bad), undefined);
});

test('scoreRepo: archived and 12-month-stale are rejected; score grows with stars; old repos get a bonus', () => {
  const m = (o = {}) => meta(100, o).meta;
  assert.deepEqual(scoreRepo(m({ archived: true }), NOWMS), { reject: 'repo-archived' });
  assert.deepEqual(scoreRepo(m({ pushedAt: NOWMS - 366 * DAY }), NOWMS), { reject: 'repo-stale' });
  assert.ok(scoreRepo(m({ pushedAt: NOWMS - 364 * DAY }), NOWMS).score > 0);
  assert.ok(scoreRepo(meta(1000).meta, NOWMS).score > scoreRepo(meta(10).meta, NOWMS).score);
  assert.ok(scoreRepo(m(), NOWMS).score > scoreRepo(m({ createdAt: NOWMS - 30 * DAY }), NOWMS).score);
});

test('ranking: score beats recency inside a tier; unscored (no repo) rank after scored; archived/stale are rejected', async () => {
  const rows = [ghRow('newest', 7, null), ghRow('lowstars', 6), ghRow('popular', 3), ghRow('dead', 5), ghRow('old', 4)];
  const stars = { lowstars: 1, popular: 5000, dead: 9000, old: 50 };
  const repoMeta = async (owner) => owner === 'dead' ? meta(9000, { archived: true }) : owner === 'old' ? meta(50, { pushedAt: NOWMS - 400 * DAY }) : meta(stars[owner]);
  const res = await sync(rows, repoMeta, { max: 10, maxPerPublisher: 2 });
  assert.deepEqual(names(res), ['io.github.popular/t', 'io.github.lowstars/t', 'io.github.newest/t']);
  assert.deepEqual(res.scope.repoStats, { checked: 4, archived: 1, stale: 1, unavailable: 0, unscored: 0, rateLimited: false });
  assert.deepEqual(res.rejected.map(r => r.reason).sort(), ['repo-archived', 'repo-stale']);
  assert.match(res.body, /5000 stars, last push 2026-10-29/);
  assert.match(res.body, /1 rejected as archived, 1 rejected for no push in 12 months/);
});

test('fail-soft: 404 defers the candidate; a rate limit stops further calls and leaves the rest unscored (still eligible); nothing throws', async () => {
  const rows = [ghRow('a', 7), ghRow('b', 6), ghRow('c', 5), ghRow('d', 4)];
  let calls = 0;
  const repoMeta = async owner => { calls++; return owner === 'a' ? { error: 'not-found' } : owner === 'b' ? { error: 'rate-limited' } : meta(10); };
  const res = await sync(rows, repoMeta, { max: 10 });
  assert.equal(calls, 2, 'no call after the rate limit');
  assert.deepEqual(names(res), ['io.github.b/t', 'io.github.c/t', 'io.github.d/t'], 'unscored keep newest-first');
  assert.equal(res.deferred, 1, 'only the 404');
  assert.equal(res.scope.repoStats.rateLimited, true);
  assert.equal(res.scope.repoStats.unscored, 3);
  assert.match(res.body, /GitHub rate limit hit/);
});

test('rate limit: scored candidates still outrank the unscored ones', async () => {
  const rows = [ghRow('a', 7), ghRow('b', 6), ghRow('c', 5)];
  const res = await sync(rows, async o => (o === 'c' ? meta(500) : { error: 'rate-limited' }), { max: 10 });
  assert.equal(res.scope.repoStats.rateLimited, true);
  assert.deepEqual(names(res), ['io.github.a/t', 'io.github.b/t', 'io.github.c/t']);
});

test('bounds: only the top maxLookups queue entries get metadata; the rest keep the old order after them', async () => {
  const rows = [ghRow('a', 7), ghRow('b', 6), ghRow('c', 5), ghRow('d', 4)];
  const seen = [];
  const res = await sync(rows, async o => { seen.push(o); return meta(o === 'b' ? 900 : 1); }, { max: 2, maxPerPublisher: 2, maxLookups: 2 });
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(names(res), ['io.github.b/t', 'io.github.a/t']);
});

test('bounds: the lookup budget stops metadata fetches; the remaining GitHub candidates stay unscored, not dropped', async () => {
  let t = 0;
  const rows = [ghRow('a', 7), ghRow('b', 6), ghRow('c', 5)];
  let calls = 0;
  const res = await sync(rows, async () => { calls++; t += 400; return meta(10); }, { max: 10, nowImpl: () => t, lookupBudgetMs: 1000, maxLookups: 10 });
  assert.ok(calls < 3, `calls=${calls}`);
  assert.ok(res.scope.repoStats.unscored >= 1);
  assert.equal(res.accepted.length, 3);
});

test('without a repoMeta fetcher nothing changes (offline runs)', async () => {
  const res = await sync([ghRow('a', 7)], undefined);
  assert.equal(res.accepted.length, 1);
  assert.equal(res.scope.repoStats, undefined);
  assert.doesNotMatch(res.body, /Repository signal/);
});

test('fetchRepoMeta: request shape, token only as a bearer header, status mapping, hostile owner/repo never reach the network', async () => {
  const calls = [];
  const body = JSON.stringify({ stargazers_count: 7, archived: false, pushed_at: '2026-10-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z' });
  const mk = (status, headers = {}, text = body) => async (url, o) => { calls.push({ url, o }); return new Response(text, { status, headers }); };
  const ok = await fetchRepoMeta('acme', 'tool', { token: 'tok123', fetchImpl: mk(200) });
  assert.equal(ok.meta.stars, 7);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/tool');
  assert.equal(calls[0].o.headers.authorization, 'Bearer tok123');
  assert.equal(calls[0].o.redirect, 'error');
  assert.equal(JSON.stringify(ok).includes('tok123'), false);
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: mk(404) }), { error: 'not-found' });
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: mk(429) }), { error: 'rate-limited' });
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: mk(403, { 'x-ratelimit-remaining': '0' }) }), { error: 'rate-limited' });
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: mk(403) }), { error: 'unavailable' });
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: mk(500) }), { error: 'unavailable' });
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: mk(200, {}, 'not json') }), { error: 'unavailable' });
  assert.deepEqual(await fetchRepoMeta('a', 'b', { fetchImpl: async () => { throw new Error('ECONNRESET'); } }), { error: 'unavailable' });
  const n = calls.length;
  for (const [o, r] of [['..', 'x'], ['a', '../x'], ['a/b', 'c'], ['a', 'b?x'], ['', 'b']]) assert.deepEqual(await fetchRepoMeta(o, r, { fetchImpl: mk(200) }), { error: 'unavailable' });
  assert.equal(calls.length, n);
});

test('CLI: the token is removed from process.env before anything else runs; --dry-run writes has_changes=false', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
  const rowsFile = path.join(dir, 'rows.json');
  fs.writeFileSync(rowsFile, JSON.stringify([{ server: { $schema: SCHEMA, version: '1.0.0', description: 'd', name: 'com.acme/a', remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.com/mcp' }] }, _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true } } }]));
  const out = path.join(dir, 'gh_output');
  fs.writeFileSync(out, '');
  const run = flag => spawnSync(process.execPath, ['scripts/sync-official/sync.mjs', '--out', path.join(dir, 'o'), '--rows-file', rowsFile, ...flag], { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'secret-token-xyz', GITHUB_OUTPUT: out } });
  const d = run(['--dry-run']);
  assert.equal(d.status, 0, d.stderr);
  assert.doesNotMatch(d.stdout + d.stderr, /secret-token-xyz/);
  assert.match(fs.readFileSync(out, 'utf8'), /has_changes=false/);
  fs.writeFileSync(out, '');
  assert.equal(run([]).status, 0);
  assert.match(fs.readFileSync(out, 'utf8'), /has_changes=true/);
  const src = fs.readFileSync(new URL('../sync-official/sync.mjs', import.meta.url), 'utf8');
  assert.ok(src.indexOf('delete process.env.GITHUB_TOKEN') < src.indexOf("await import('./schema-validate.mjs')"), 'token removed before ajv is imported');
});

test('F1: archived/stale rejections use up checks and the window refills; a GitHub candidate is never accepted unchecked', async () => {
  const rows = [ghRow('arch', 7), ghRow('stale', 6), ghRow('good', 5), ghRow('tail', 4)];
  const checked = [];
  const repoMeta = async o => { checked.push(o); return o === 'arch' ? meta(1, { archived: true }) : o === 'stale' ? meta(1, { pushedAt: NOWMS - 400 * DAY }) : meta(5); };
  const one = await sync(rows, repoMeta, { max: 10, maxPerPublisher: 2, maxLookups: 1 });
  assert.deepEqual(names(one), [], 'cap spent on the archived repo: nothing accepted, in particular not stale/good/tail');
  checked.length = 0;
  const three = await sync(rows, repoMeta, { max: 10, maxPerPublisher: 2, maxLookups: 3 });
  assert.deepEqual(names(three), ['io.github.good/t']);
  assert.deepEqual(checked, ['arch', 'stale', 'good']);
  assert.ok(!names(three).includes('io.github.tail/t'), 'tail is past the check cap and unchecked');
  checked.length = 0;
  const refill = await sync(rows, repoMeta, { max: 1, maxPerPublisher: 2, maxLookups: 10 });
  assert.deepEqual(names(refill), ['io.github.good/t']);
});
