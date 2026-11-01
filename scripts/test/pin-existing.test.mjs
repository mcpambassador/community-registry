import test from 'node:test';
import assert from 'node:assert/strict';
import { planPins, lookupNpm, lookupPypi } from '../sync-official/pin-existing.mjs';
import { pinProblem } from '../lib/checks.mjs';

const REG = `schema_version: '1'
mcps:
- name: pyone
  config:
    command:
    - uvx
    - pkg-one
  version: 1.0.0
- name: scoped
  config:
    # NOTE: keep
    command:
    - npx
    - -y
    - '@s/pkg'
  version: 1.0.0

- name: already
  config:
    command:
    - npx
    - -y
    - ok@1.2.3
- name: gone
  config:
    command:
    - uvx
    - nope
- name: alpha
  config:
    command:
    - uvx
    - alpha-pkg
`;
const npm = async n => (n === '@s/pkg' ? { version: '2.0.0', integrity: 'sha512-AAAA' } : { missing: true });
const pypi = async n => ({ 'pkg-one': { version: '0.4.0', integrity: ['a'.repeat(64), 'b'.repeat(64)] }, nope: { missing: true }, 'alpha-pkg': { error: 'alpha-pkg latest is not a plain release (0.0.1a8)' } })[n];

test('pins unpinned entries, reports missing and errors, leaves pinned alone', async () => {
  const out = await planPins(REG, { npm, pypi });
  assert.deepEqual(out.pinned.map(p => p.to), ['pkg-one==0.4.0', '@s/pkg@2.0.0']);
  assert.deepEqual(out.missing.map(m => m.name), ['gone']);
  assert.equal(out.errors.length, 1);
  assert.match(out.text, /    - pkg-one==0\.4\.0\n/);
  assert.match(out.text, /    - '@s\/pkg@2\.0\.0'\n/);
  assert.match(out.text, /  package_integrity:\n    pypi:\n    - a{64}\n    - b{64}\n- name: scoped/);
  assert.match(out.text, /  package_integrity:\n    npm: sha512-AAAA\n\n- name: already/);
  assert.match(out.text, /# NOTE: keep/);
  assert.equal(out.text.match(/ok@1\.2\.3/g).length, 1);
});

test('output satisfies the pin rule for pinned entries and is idempotent', async () => {
  const once = await planPins(REG, { npm, pypi });
  const twice = await planPins(once.text, { npm, pypi });
  assert.equal(twice.pinned.length, 0);
  assert.equal(pinProblem(['uvx', 'pkg-one==0.4.0']), null);
});

test('npm lookup validates the response', async () => {
  const ok = await lookupNpm('@s/pkg', async url => { assert.match(url, /%2fpkg\/latest$/); return { status: 200, json: { version: '1.2.3', dist: { integrity: 'sha512-Zm9v' } } }; });
  assert.deepEqual(ok, { version: '1.2.3', integrity: 'sha512-Zm9v' });
  assert.ok((await lookupNpm('x', async () => ({ status: 200, json: { version: '1.0.0-beta.1', dist: {} } }))).error);
  assert.ok((await lookupNpm('x', async () => ({ status: 200, json: { version: '1.0.0', dist: { integrity: 'sha1-zz' } } }))).error);
  assert.ok((await lookupNpm('../evil', async () => assert.fail('must not fetch'))).error);
  assert.deepEqual(await lookupNpm('x', async () => ({ status: 404 })), { missing: true });
});

test('pypi lookup collects unique sorted sha256 digests, skips yanked', async () => {
  const d = c => ({ digests: { sha256: c.repeat(64) } });
  const r = await lookupPypi('p', async () => ({ status: 200, json: { info: { version: '1.0.post1' }, urls: [d('b'), d('a'), d('a'), { ...d('c'), yanked: true }] } }));
  assert.deepEqual(r, { version: '1.0.post1', integrity: ['a'.repeat(64), 'b'.repeat(64)] });
  assert.ok((await lookupPypi('p', async () => ({ status: 200, json: { info: { version: '0.0.1a8' }, urls: [d('a')] } }))).error);
});
