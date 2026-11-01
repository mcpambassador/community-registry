import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import yaml from '../lib/yaml.mjs';
import { evaluate, cheapDrop, mapArguments, editDistance, nearMatch, parseOfficialName, chooseSlug, OFFICIAL_META_KEY } from '../sync-official/eligibility.mjs';
import { LIMITS, fetchAll, getJson, parsePage, jsonDepth, ALLOWED_SCHEMAS } from '../sync-official/fetch-official.mjs';
import { runSync } from '../sync-official/sync.mjs';
import { lookupCandidate, hasPypiMarker } from '../sync-official/index-lookup.mjs';
import { makeValidator } from '../sync-official/schema-validate.mjs';
import { renderPrBody } from '../sync-official/pr-body.mjs';

const SCHEMA = [...ALLOWED_SCHEMAS][0];
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/official-rows.json', import.meta.url), 'utf8'));
const registryText = fs.readFileSync(new URL('../../registry.yaml', import.meta.url), 'utf8');
const top = JSON.parse(fs.readFileSync(new URL('../sync-official/top-packages.json', import.meta.url), 'utf8'));
const validate = makeValidator();
const NOW = '2026-11-08T00:00:00Z';

const ctx = (over = {}) => ({
  takenSlugs: new Set(['fetch-x']), existingOfficialNames: new Set(), knownSlugs: new Set(['fetch-x']), knownPackages: new Set(),
  denyNames: new Set(), denyPackages: new Set(), ...over,
});
const row = (server, meta = {}) => ({ server: { $schema: SCHEMA, version: '1.0.0', description: 'd', ...server }, _meta: { [OFFICIAL_META_KEY]: { status: 'active', isLatest: true, ...meta } } });
const npmPkg = (over = {}) => ({ registryType: 'npm', identifier: 'thing-mcp', version: '1.2.3', transport: { type: 'stdio' }, ...over });
const npmRow = (over = {}, name = 'io.github.acme/thing') => row({ name, packages: [npmPkg(over)] });
const remoteRow = (url, name = 'com.acme/thing', extra = {}) => row({ name, remotes: [{ type: 'streamable-http', url, ...extra }] });

test('status, latest, name shape', () => {
  assert.equal(evaluate(npmRow({}), ctx()).ok, true);
  assert.equal(evaluate(row({ name: 'io.github.acme/thing', packages: [npmPkg()] }, { status: 'deprecated' }), ctx()).reason, 'status-not-active');
  assert.equal(evaluate(row({ name: 'io.github.acme/thing', packages: [npmPkg()] }, { status: undefined }), ctx()).reason, 'status-not-active');
  assert.equal(evaluate(row({ name: 'io.github.acme/thing', packages: [npmPkg()] }, { isLatest: false }), ctx()).reason, 'not-latest');
  assert.equal(evaluate(row({ name: 'no-namespace', packages: [npmPkg()] }), ctx()).reason, 'bad-name');
});

test('package types and registries', () => {
  for (const t of ['oci', 'nuget', 'cargo', 'mcpb']) {
    assert.equal(evaluate(row({ name: 'io.github.acme/thing', packages: [{ registryType: t, identifier: 'x', version: '1.0.0', transport: { type: 'stdio' } }] }), ctx()).reason, 'unsupported-type', t);
  }
  assert.equal(evaluate(row({ name: 'com.acme/thing', remotes: [{ type: 'sse', url: 'https://acme.com/sse' }] }), ctx()).reason, 'unsupported-type');
  assert.equal(evaluate(npmRow({ registryBaseUrl: 'https://evil.example' }), ctx()).reason, 'custom-registry');
  assert.equal(evaluate(npmRow({ registryBaseUrl: 'https://registry.npmjs.org' }), ctx()).ok, true);
  assert.equal(evaluate(npmRow({ transport: { type: 'streamable-http' } }), ctx()).reason, 'unsupported-transport');
  for (const v of ['1.0', '^1.0.0', 'latest', '1.0.0-beta.1']) assert.equal(evaluate(npmRow({ version: v }), ctx()).reason, 'version-not-exact', v);
  assert.equal(evaluate(npmRow({ identifier: '../evil' }), ctx()).reason, 'bad-package-identifier');
  const both = row({ name: 'io.github.acme/thing', packages: [npmPkg(), { registryType: 'pypi', identifier: 'thing', version: '1.0.0', transport: { type: 'stdio' } }] });
  assert.equal(evaluate(both, ctx()).reason, 'ambiguous-multiple-runnable');
});

test('deny list, existing, collisions, reserved and generic names', () => {
  assert.equal(evaluate(npmRow({}), ctx({ denyNames: new Set(['io.github.acme/thing']) })).reason, 'deny-listed');
  assert.equal(evaluate(npmRow({ identifier: 'bad-pkg' }), ctx({ denyPackages: new Set(['bad-pkg']) })).reason, 'deny-listed');
  assert.equal(evaluate(npmRow({}), ctx({ existingOfficialNames: new Set(['io.github.acme/thing']) })).reason, 'already-synced');
  const bare = evaluate(npmRow({}), ctx());
  assert.equal(bare.plan.slug, 'thing');
  const taken = evaluate(npmRow({}), ctx({ takenSlugs: new Set(['thing']) }));
  assert.equal(taken.plan.slug, 'acme-thing');
  assert.ok(taken.plan.flags.has('forced-slug'));
  for (const n of ['fetch', 'github', 'time', 'sqlite', 'postgres', 'filesystem', 'memory', 'git']) {
    const r = evaluate(npmRow({}, `io.github.acme/${n}`), ctx());
    assert.equal(r.plan.slug, `acme-${n}`, n);
    assert.ok(r.plan.flags.has('forced-slug'));
  }
  assert.equal(evaluate(npmRow({}, 'ai.2kw/mcp-server'), ctx()).plan.slug, '2kw-mcp-server');
  const forcedTaken = evaluate(npmRow({}, 'io.github.acme/fetch'), ctx({ takenSlugs: new Set(['acme-fetch']) }));
  assert.equal(forcedTaken.reason, 'slug-unavailable');
});

test('edit distance: slugs and package identifiers are flagged, not just warned', () => {
  assert.equal(editDistance('github', 'githbu'), 1); // transposition
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(nearMatch('gitub-mcp', new Set(['github-mcp']))?.match, 'github-mcp');
  assert.equal(nearMatch('totally-different', new Set(['github-mcp'])), undefined);
  const s = evaluate(npmRow({}, 'io.github.acme/postgrse'), ctx({ knownSlugs: new Set(['postgres']) }));
  assert.ok(s.plan.flags.has('name-near-match'));
  const p = evaluate(npmRow({ identifier: '@modelcontextprotocol/server-filesytem' }), ctx({ knownPackages: new Set(['@modelcontextprotocol/server-filesystem']) }));
  assert.ok(p.plan.flags.has('name-near-match'));
  assert.deepEqual(p.plan.nearMatches, ['@modelcontextprotocol/server-filesystem']);
});

test('arguments: allowlisted shapes accepted, runner-changing and unsafe rejected (S5)', () => {
  const ok = mapArguments({ packageArguments: [{ type: 'positional', value: 'serve' }, { type: 'named', name: '--port', value: '8080' }] });
  assert.deepEqual(ok.argv, ['serve', '--port', '8080']);
  for (const flag of ['--registry', '--index-url', '--extra-index-url', '-c', '--from', '--with', '--find-links', '--config', '--userconfig', '--prefix', '--cache', '--with-requirements']) {
    assert.ok(mapArguments({ packageArguments: [{ type: 'named', name: flag, value: 'x' }] }).error, flag);
  }
  assert.ok(mapArguments({ packageArguments: [{ type: 'named', name: '@scope:registry=https://x', value: 'y' }] }).error);
  for (const v of ['a b', 'a;b', '$(id)', '`id`', 'a|b', '${HOME}', 'https://evil.example/pkg', 'x'.repeat(201), '']) {
    assert.ok(mapArguments({ packageArguments: [{ type: 'positional', value: v }] }).error, JSON.stringify(v));
  }
  assert.ok(mapArguments({ packageArguments: [{ type: 'positional', value: '--index-url' }] }).error);
  assert.ok(mapArguments({ packageArguments: [{ type: 'positional' }] }).error); // user-supplied, no literal value
  assert.ok(mapArguments({ runtimeArguments: [{ type: 'named', name: '-y', value: 'x' }] }).error);
  assert.ok(mapArguments({ packageArguments: [{ type: 'named', name: '--x', value: 'y', isRepeated: true }] }).error);
  assert.equal(evaluate(npmRow({ packageArguments: [{ type: 'named', name: '--registry', value: 'x' }] }), ctx()).reason, 'arguments-rejected');
});

test('remotes: https only, host/namespace match flagged, headers and templates are manual', () => {
  const ok = evaluate(remoteRow('https://mcp.acme.com/mcp'), ctx());
  assert.equal(ok.ok, true);
  assert.ok(ok.plan.flags.has('pinning-none'));
  assert.ok(!ok.plan.flags.has('host-mismatch'));
  assert.ok(evaluate(remoteRow('https://evil.example/mcp'), ctx()).plan.flags.has('host-mismatch'));
  assert.ok(evaluate(remoteRow('https://notacme.com/mcp'), ctx()).plan.flags.has('host-mismatch'));
  for (const u of ['http://mcp.acme.com/mcp', 'https://localhost/mcp', 'https://10.0.0.1/mcp', 'https://u:p@mcp.acme.com/', 'ftp://acme.com']) {
    assert.equal(evaluate(remoteRow(u), ctx()).reason, 'remote-not-public-https', u);
  }
  assert.equal(evaluate(remoteRow('https://{tenant}.acme.com/mcp'), ctx()).ok, false);
  assert.equal(evaluate(remoteRow('https://mcp.acme.com/mcp', 'com.acme/thing', { headers: [{ name: 'Authorization', isRequired: true }] }), ctx()).reason, 'remote-needs-headers');
  const gh = evaluate(remoteRow('https://acme.github.io/mcp', 'io.github.acme/thing'), ctx());
  assert.ok(!gh.plan.flags.has('host-mismatch'));
  assert.ok(evaluate(remoteRow('https://other.github.io/mcp', 'io.github.acme/thing'), ctx()).plan.flags.has('host-mismatch'));
  assert.equal(parseOfficialName('io.github.acme/thing').domain, 'acme.github.io');
  assert.equal(parseOfficialName('com.acme/thing').domain, 'acme.com');
});

// ---------- bounds (S2) ----------
const jsonRes = (obj, extra = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' }, ...extra });
const page = (names, nextCursor = '') => ({ servers: names.map(n => row({ name: n, packages: [npmPkg()] })), metadata: { nextCursor, count: names.length } });

test('fetchAll: pages through, stops at an empty cursor', async () => {
  const pages = [page(['io.github.a/a', 'io.github.b/b'], 'c1'), page(['io.github.c/c'])];
  let i = 0;
  const out = await fetchAll({ fetchImpl: async () => jsonRes(pages[i++]) });
  assert.equal(out.rows.length, 3);
  assert.equal(out.pages, 2);
});

test('fetchAll: repeated cursor, empty-progress page, page cap and row cap all fail closed', async () => {
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(page(['io.github.a/a'], 'same')) }), /cursor loop|no new rows/);
  let n = 0;
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(page([`io.github.a/n${n++}`], `c${n}`)), maxPages: 3 }), /page cap/);
  let m = 0;
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(page([`io.github.a/m${m++}`, `io.github.a/m${m++}`], `d${m}`)), maxRawRows: 3 }), /raw row cap/);
});

test('fetchAll: requests latest versions at the max page size, with the documented caps', async () => {
  let url;
  await fetchAll({ fetchImpl: async u => { url = u; return jsonRes(page(['io.github.a/a'])); } });
  assert.match(url, /limit=100&version=latest/);
  assert.deepEqual([LIMITS.pageSize, LIMITS.maxPages, LIMITS.maxRawRows, LIMITS.budgetMs], [100, 1650, 165_000, 600_000]);
});

test('fetchAll: early-drop keeps survivors only; the raw-row cap governs and counts dropped rows too; there is no separate kept-row cap', async () => {
  const keep = r => (r.server.name.startsWith('io.github.drop') ? 'dropped-x' : undefined);
  const pages = [page(['io.github.drop/1', 'io.github.drop/2', 'io.github.ok/1'], 'c1'), page(['io.github.drop/3'])];
  let i = 0;
  const out = await fetchAll({ fetchImpl: async () => jsonRes(pages[i++]), keep });
  assert.deepEqual(out.rows.map(r => r.server.name), ['io.github.ok/1']);
  assert.equal(out.rawRows, 4);
  assert.deepEqual(out.dropped, { 'dropped-x': 3 });
  let n = 0;
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(page([`io.github.drop/r${n++}`, `io.github.drop/r${n++}`], `r${n}`)), keep, maxRawRows: 5 }), /raw row cap/);
  let k = 0;
  const many = await fetchAll({ fetchImpl: async () => jsonRes(k < 4 ? page([`io.github.drop/z${k++}`, `io.github.drop/z${k++}`], `z${k}`) : page([])), keep, maxRawRows: 100 });
  assert.equal(many.rows.length, 0);
  let q = 0;
  const kept = await fetchAll({ fetchImpl: async () => jsonRes(q < 6 ? page([`io.github.ok/q${q++}`, `io.github.ok/q${q++}`], `q${q}`) : page([])), maxRawRows: 100 });
  assert.equal(kept.rows.length, 6); // kept rows are not capped separately; only the raw cap bounds the walk
});

test('fetchAll: wall-clock budget fails closed with a clear error', async () => {
  let t = 0;
  let n = 0;
  await assert.rejects(
    fetchAll({ fetchImpl: async () => { t += 400; return jsonRes(page([`io.github.a/t${n++}`], `t${n}`)); }, nowImpl: () => t, budgetMs: 1000 }),
    /time budget \(1s\) exhausted/,
  );
});

test('fetchAll: logs progress every N pages', async () => {
  const logs = [];
  let n = 0;
  await assert.rejects(fetchAll({ fetchImpl: async () => jsonRes(page([`io.github.a/l${n++}`], `l${n}`)), maxPages: 5, logEvery: 2, log: m => logs.push(m) }), /page cap/);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /2 pages, 2 raw rows, 2 kept/);
});

test('cheapDrop agrees with evaluate on the network-free reasons', () => {
  const c = ctx({ denyNames: new Set(['io.github.acme/thing']) });
  assert.equal(cheapDrop(npmRow({}), c).reason, 'deny-listed');
  assert.equal(cheapDrop(row({ name: 'io.github.acme/thing', packages: [npmPkg()] }, { isLatest: false }), ctx()).reason, 'not-latest');
  assert.equal(cheapDrop(npmRow({}), ctx()).ok, true);
});

test('getJson: oversized body aborted at the cap, declared and streamed', async () => {
  await assert.rejects(getJson('https://x.example/', { fetchImpl: async () => new Response('x'.repeat(2000)), maxBytes: 1000 }), /too large/);
  const big = new Response('x'.repeat(10), { headers: { 'content-length': '999999999' } });
  await assert.rejects(getJson('https://x.example/', { fetchImpl: async () => big, maxBytes: 1000 }), /too large/);
});

test('getJson: timeout, HTTP errors, redirects, depth', async () => {
  const keepAlive = setInterval(() => {}, 10); // AbortSignal.timeout timers are unref'd; a real socket keeps the loop alive
  await assert.rejects(getJson('https://x.example/', { fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))), timeoutMs: 20 }), /aborted/);
  clearInterval(keepAlive);
  await assert.rejects(getJson('https://x.example/', { fetchImpl: async () => new Response('', { status: 500 }) }), /HTTP 500/);
  assert.deepEqual(await getJson('https://x.example/', { fetchImpl: async () => new Response('', { status: 404 }) }), { status: 404 });
  let deep = '1';
  for (let i = 0; i < 60; i++) deep = `[${deep}]`;
  await assert.rejects(getJson('https://x.example/', { fetchImpl: async () => new Response(deep) }), /nested too deeply/);
  assert.equal(jsonDepth({ a: [{ b: 1 }] }), 3);
  let seen;
  await getJson('https://x.example/', { fetchImpl: async (u, o) => { seen = o; return jsonRes({}); } });
  assert.equal(seen.redirect, 'error');
});

test('parsePage: unknown $schema and malformed rows are skipped; wrong shape throws', () => {
  const p = parsePage({
    servers: [row({ name: 'io.github.a/a' }), { server: { $schema: 'https://evil.example/s.json', name: 'io.github.b/b', version: '1' } }, { server: 'x' }, null],
    metadata: { nextCursor: '' },
  });
  assert.equal(p.rows.length, 1);
  assert.deepEqual(p.skipped.map(s => s.reason), ['unknown-$schema', 'malformed-row', 'malformed-row']);
  assert.throws(() => parsePage({ nope: 1 }), /unexpected page shape/);
  assert.throws(() => parsePage({ servers: [], metadata: { nextCursor: 'x'.repeat(600) } }), /cursor too long/);
});

// ---------- mapper ----------
const okLookup = async plan => (plan.kind === 'remote' ? { ok: true, flags: [] } : {
  ok: true, dependenciesPinned: false, flags: ['dependencies-unpinned'],
  packageIntegrity: plan.kind === 'npm' ? { npm: 'sha512-AAAA' } : { pypi: ['a'.repeat(64)] },
});
const sync = (rows, over = {}) => runSync({ registryText, rows, now: NOW, lookup: okLookup, validate, deny: { names: [], packages: [] }, top, ...over });

test('golden fixtures map to schema-valid, check-clean entries', async () => {
  const res = await sync(fixtures);
  assert.equal(res.accepted.length, 4, JSON.stringify(res.rejected));
  const doc = yaml.load(res.registryText);
  assert.equal(doc.mcps.length, yaml.load(registryText).mcps.length + 4);
  for (const { entry } of res.accepted) {
    assert.equal(validate(entry), null);
    assert.equal(entry.verified, false);
    assert.equal(entry.source, 'official-registry');
    assert.equal(entry.oauth_config, undefined);
    assert.equal(entry.synced_at, NOW);
  }
  const twokw = res.accepted.find(a => a.plan.officialName === 'ai.2kw/mcp-server').entry;
  assert.equal(twokw.name, '2kw-mcp-server');
  assert.deepEqual(twokw.config.command.slice(0, 3), ['npx', '-y', '@2kw/ai-mcp-server@8.0.3']);
  assert.equal(twokw.auth_type, 'static');
  assert.deepEqual(twokw.credential_schema.required, ['AI_2KW_API_KEY']);
  assert.equal(twokw.isolation_mode, 'per_user');
  const remote = res.accepted.find(a => a.plan.kind === 'remote').entry;
  assert.equal(remote.transport_type, 'http');
  assert.equal(remote.pinning, 'none');
  assert.equal(remote.package_integrity, undefined);
});

test('the generated registry passes the sync-PR diff-scope', async () => {
  const { diffScope, universalChecks, changedEntries } = await import('../lib/checks.mjs');
  const res = await sync(fixtures);
  const base = yaml.load(registryText).mcps;
  const head = yaml.load(res.registryText).mcps;
  assert.deepEqual(diffScope({ baseMcps: base, headMcps: head, changedFiles: ['registry.yaml'] }), []);
  assert.deepEqual(universalChecks({ baseMcps: base, headMcps: head }), []);
  assert.equal(changedEntries(base, head).added.length, 4);
});

test('field-by-field: hostile upstream keys never reach the entry (prototype-pollution safe)', async () => {
  const hostile = JSON.parse(`{"server":{"$schema":"${SCHEMA}","name":"io.github.evil/thing","version":"1.0.0","description":"x",
    "__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"command":["curl","evil"],"oauth_config":{"auth_url":"https://evil"},
    "verified":true,"config":{"command":["sh"]},
    "packages":[{"registryType":"npm","identifier":"thing-mcp","version":"1.2.3","transport":{"type":"stdio"},"__proto__":{"x":1},"command":"sh","oauth_config":{},
      "environmentVariables":[{"name":"API_KEY","isSecret":true,"__proto__":{"y":1},"command":"sh"}]}]},
    "_meta":{"${OFFICIAL_META_KEY}":{"status":"active","isLatest":true}}}`);
  const res = await sync([hostile]);
  assert.equal(res.accepted.length, 1, JSON.stringify(res.rejected));
  const e = res.accepted[0].entry;
  assert.equal(e.oauth_config, undefined);
  assert.equal(e.verified, false);
  assert.deepEqual(e.config.command, ['npx', '-y', 'thing-mcp@1.2.3']);
  assert.equal(Object.keys(e).includes('command'), false);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(e), Object.prototype);
  const allowed = new Set(['name', 'display_name', 'description', 'transport_type', 'config', 'auth_type', 'credential_schema', 'isolation_mode', 'requires_user_credentials', 'category', 'repository_url', 'documentation_url', 'version', 'maintainer', 'verified', 'source', 'official_name', 'namespace_verification', 'package_integrity', 'dependencies_pinned', 'pinning', 'flags', 'synced_at']);
  for (const k of Object.keys(e)) assert.ok(allowed.has(k), k);
});

test('text: control, zero-width and bidi characters are stripped; caps applied; plain http left in text is rejected', async () => {
  const r = npmRow({}, 'io.github.acme/thing');
  r.server.description = 'Hello​ ‮world\u0007 ' + 'x'.repeat(900);
  r.server.title = 'T​itle';
  const res = await sync([r]);
  const e = res.accepted[0].entry;
  assert.ok(e.description.length <= 500);
  assert.ok(!/[​‮\u0007]/.test(e.description + e.display_name));
  assert.equal(e.display_name, 'Title');
  const h = npmRow({}, 'io.github.acme/other');
  h.server.description = 'see http://evil.example now';
  const res2 = await sync([h]);
  assert.equal(res2.accepted.length, 0);
  assert.equal(res2.rejected[0].reason, 'text-lint');
});

test('per-run cap defers the rest; output is deterministic; collisions inside one run get forced slugs', async () => {
  const rows = ['io.github.a/one', 'io.github.b/one', 'io.github.c/three'].map(n => npmRow({ identifier: n.replace(/\W/g, '-') }, n));
  const a = await sync(rows, { max: 2 });
  assert.equal(a.accepted.length, 2);
  assert.equal(a.deferred, 1);
  assert.deepEqual(a.accepted.map(x => x.entry.name), ['one', 'b-one']);
  assert.equal((await sync([...rows].reverse(), { max: 2 })).registryText, a.registryText);
});

test('lookup failures and rejections never produce entries', async () => {
  const r1 = await sync([npmRow({}, 'io.github.acme/a')], { lookup: async () => { throw new Error('boom'); } });
  assert.equal(r1.rejected[0].reason, 'index-lookup-failed');
  const r2 = await sync([npmRow({}, 'io.github.acme/a')], { lookup: async () => ({ ok: false, reason: 'ownership-marker-missing' }) });
  assert.equal(r2.rejected[0].reason, 'ownership-marker-missing');
  assert.equal(r2.registryText, registryText.endsWith('\n') ? registryText : registryText + '\n');
});

test('PR body: upstream text is confined to code spans; no mentions, links or tables injected', async () => {
  const r = npmRow({}, 'io.github.acme/thing');
  r.server.title = '@everyone [click](https://evil.example) `x` | y\n# heading';
  const res = await sync([r]);
  assert.ok(!/^# heading/m.test(res.body));
  assert.ok(!res.body.includes('](https://evil.example)'));
  const body = renderPrBody({ accepted: [], rejected: [{ name: '@team `x`\n| a |', reason: 'custom', detail: '[l](http://x)' }], skipped: [], stats: { rows: 1, pages: 1, rejected: 1, deferred: 0 }, date: '2026-11-08', dryRun: false });
  assert.ok(!/\|\s*@team/.test(body));
  assert.ok(body.length < 65000);
});

// ---------- index lookups ----------
const mkNpm = over => ({ status: 200, json: { version: '1.2.3', mcpName: 'io.github.acme/thing', dist: { integrity: 'sha512-AAAA' }, _hasShrinkwrap: false, ...over } });
const npmPlan = { kind: 'npm', identifier: '@s/thing', version: '1.2.3', officialName: 'io.github.acme/thing' };
const NOWMS = Date.parse(NOW);

test('npm lookup: ownership marker, integrity, flags for new/low-download packages', async () => {
  const get = async url => {
    if (url.includes('api.npmjs.org')) return { status: 200, json: { downloads: 50 } };
    if (url.endsWith('/1.2.3')) return mkNpm();
    return { status: 200, json: { time: { created: '2026-10-20T00:00:00Z' } } };
  };
  const r = await lookupCandidate(npmPlan, NOWMS, get);
  assert.equal(r.ok, true);
  assert.deepEqual(r.packageIntegrity, { npm: 'sha512-AAAA' });
  assert.ok(['new-package', 'low-downloads', 'dependencies-unpinned'].every(f => r.flags.includes(f)));
  assert.equal((await lookupCandidate(npmPlan, NOWMS, async () => mkNpm({ mcpName: 'io.github.other/thing' }))).reason, 'ownership-marker-missing');
  assert.equal((await lookupCandidate(npmPlan, NOWMS, async () => mkNpm({ dist: {} }))).reason, 'no-integrity');
  assert.equal((await lookupCandidate(npmPlan, NOWMS, async () => mkNpm({ version: '9.9.9' }))).reason, 'index-version-mismatch');
  assert.equal((await lookupCandidate(npmPlan, NOWMS, async () => ({ status: 404 }))).reason, 'package-not-found');
  const flaky = await lookupCandidate(npmPlan, NOWMS, async url => { if (url.endsWith('/1.2.3')) return mkNpm({ _hasShrinkwrap: true }); throw new Error('net'); });
  assert.ok(flaky.ok && flaky.flags.includes('age-unknown') && flaky.flags.includes('downloads-unknown') && flaky.dependenciesPinned === true);
});

test('pypi lookup: README marker must name the server exactly; file digest set recorded', async () => {
  const plan = { kind: 'pypi', identifier: 'thing', version: '1.0.0', officialName: 'io.github.acme/thing' };
  const doc = readme => ({ status: 200, json: { info: { version: '1.0.0', description: readme }, urls: [{ digests: { sha256: 'b'.repeat(64) } }, { digests: { sha256: 'a'.repeat(64) } }, { yanked: true, digests: { sha256: 'c'.repeat(64) } }] } });
  const r = await lookupCandidate(plan, NOWMS, async () => doc('# T\n\nmcp-name: io.github.acme/thing\n'));
  assert.deepEqual(r.packageIntegrity, { pypi: ['a'.repeat(64), 'b'.repeat(64)] });
  assert.equal((await lookupCandidate(plan, NOWMS, async () => doc('mcp-name: io.github.acme/thing-evil'))).reason, 'ownership-marker-missing');
  assert.equal((await lookupCandidate(plan, NOWMS, async () => doc('no marker'))).reason, 'ownership-marker-missing');
  assert.equal(hasPypiMarker('mcp-name: io.github.acme/thing', 'io.github.acme/thing'), true);
  assert.equal(hasPypiMarker(undefined, 'x/y'), false);
});

test('remote candidates need no index lookup', async () => {
  assert.deepEqual(await lookupCandidate({ kind: 'remote' }, NOWMS, async () => assert.fail('no network')), { ok: true, flags: [] });
});

test('chooseSlug is deterministic and schema-shaped', () => {
  const p = parseOfficialName('io.github.Some-User/My_Tool.v2');
  assert.deepEqual(chooseSlug(p, new Set()), { slug: 'my-tool-v2', forced: false });
  assert.equal(chooseSlug(p, new Set(['my-tool-v2'])).slug, 'some-user-my-tool-v2');
});

test('vendored js-yaml is byte-identical to the locked dependency and to the pinned hash', () => {
  const vendored = fs.readFileSync(new URL('../vendor/js-yaml.mjs', import.meta.url));
  const locked = fs.readFileSync(new URL('../../node_modules/js-yaml/dist/js-yaml.mjs', import.meta.url));
  assert.equal(crypto.createHash('sha256').update(vendored).digest('hex'), crypto.createHash('sha256').update(locked).digest('hex'));
  assert.equal(crypto.createHash('sha256').update(vendored).digest('hex'), '16f210b939b359b6ec8dde581eb62c157185711dc7b719b33779c43db5c31a91');
});
