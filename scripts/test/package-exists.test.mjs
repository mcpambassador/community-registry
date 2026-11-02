import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePin, indexUrl, checkPin, checkEntries } from '../ci/package-exists.mjs';

const res = status => ({ status });

test('parsePin and indexUrl for npm (plain, scoped) and PyPI', () => {
  assert.deepEqual(parsePin(['npx', '-y', 'pkg@1.2.3']), { runner: 'npx', name: 'pkg', version: '1.2.3' });
  assert.deepEqual(parsePin(['npx', '-y', '@s/pkg@1.0.0-beta.1']), { runner: 'npx', name: '@s/pkg', version: '1.0.0-beta.1' });
  assert.deepEqual(parsePin(['uvx', 'my_pkg[x]==2.0']), { runner: 'uvx', name: 'my_pkg', version: '2.0' });
  assert.equal(parsePin(['node', 'a.js']), null);
  assert.equal(parsePin(['npx', '-y', 'pkg']), null);
  assert.equal(indexUrl(parsePin(['npx', 'pkg@1.2.3'])), 'https://registry.npmjs.org/pkg/1.2.3');
  assert.equal(indexUrl(parsePin(['npx', '@s/pkg@1.2.3'])), 'https://registry.npmjs.org/@s%2Fpkg/1.2.3');
  assert.equal(indexUrl(parsePin(['uvx', 'mcp-server-time==2026.1.1'])), 'https://pypi.org/pypi/mcp-server-time/2026.1.1/json');
});

test('checkPin: 200 found, 404 missing, 5xx retried then unknown, timeout unknown', async () => {
  const pin = { runner: 'npx', name: 'p', version: '1.0.0' };
  assert.equal((await checkPin(pin, async () => res(200))).status, 'found');
  assert.equal((await checkPin(pin, async () => res(404))).status, 'missing');
  let n = 0;
  const flaky = async () => (++n < 3 ? res(503) : res(200));
  assert.equal((await checkPin(pin, flaky, { retries: 2, timeoutMs: 50 })).status, 'found');
  assert.equal(n, 3);
  const r = await checkPin(pin, async () => res(500), { retries: 1, timeoutMs: 50 });
  assert.deepEqual(r, { status: 'unknown', detail: 'HTTP 500' });
  const hang = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  const t = await checkPin(pin, hang, { retries: 0, timeoutMs: 20 });
  assert.equal(t.status, 'unknown');
  assert.match(t.detail, /timeout/);
});

test('checkEntries names the entry and dedupes lookups', async () => {
  const entries = [
    { name: 'good', config: { command: ['npx', '-y', 'a@1.0.0'] } },
    { name: 'ghost', config: { command: ['npx', '-y', '@grafana/mcp-server@1.0.0'] } },
    { name: 'http', config: { url: 'https://x' } },
    { name: 'dup', config: { command: ['npx', '-y', 'a@1.0.0'] } },
  ];
  const urls = [];
  const out = await checkEntries(entries, async u => { urls.push(u); return res(u.includes('grafana') ? 404 : 200); });
  assert.equal(out.checked, 3);
  assert.equal(urls.length, 2);
  assert.equal(out.missing.length, 1);
  assert.match(out.missing[0], /^\[ghost\] npm package @grafana\/mcp-server@1\.0\.0 does not exist/);
  assert.deepEqual(out.unknown, []);
});

test('invalid package names/versions are flagged and never fetched', async () => {
  const bad = [
    { name: 'a', config: { command: ['npx', '-y', 'Bad Name@1.0.0'] } },
    { name: 'b', config: { command: ['npx', '-y', 'ok@1.0.0/../x'] } },
    { name: 'c', config: { command: ['uvx', 'pkg==1.0 evil'] } },
  ];
  let calls = 0;
  const r = await checkEntries(bad, async () => { calls++; return { status: 200 }; });
  assert.equal(calls, 0);
  assert.equal(r.missing.length, 3);
  assert.match(r.missing[0], /not a valid npm identifier/);
});

test('checkPin refuses redirects', async () => {
  let opts;
  await checkPin({ runner: 'npx', name: 'p', version: '1.0.0' }, async (_u, o) => { opts = o; return { status: 200 }; });
  assert.equal(opts.redirect, 'error');
});
