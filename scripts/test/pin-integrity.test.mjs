import test from 'node:test';
import assert from 'node:assert/strict';
import { planIntegrity } from '../sync-official/pin-integrity.mjs';
import { checkEntries } from '../ci/package-exists.mjs';
import { universalChecks } from '../lib/checks.mjs';

const SRI = 'sha512-' + 'A'.repeat(86) + '==';
const REG = `schema_version: '1'
mcps:
- name: one
  config:
    command:
    - npx
    - -y
    - '@s/pkg@1.2.3'
  version: 1.2.3

- name: has
  config:
    command:
    - npx
    - -y
    - ok@1.0.0
  package_integrity:
    npm: ${SRI}
- name: py
  config:
    command:
    - uvx
    - p==1.0
- name: unpinned
  config:
    command:
    - npx
    - -y
    - loose
`;

test('planIntegrity adds npm integrity only to pinned npx entries without one', async () => {
  const calls = [];
  const out = await planIntegrity(REG, { npm: async (n, v) => { calls.push(`${n}@${v}`); return { integrity: SRI }; } });
  assert.deepEqual(calls, ['@s/pkg@1.2.3']);
  assert.equal(out.added.length, 1);
  assert.match(out.text, /  version: 1\.2\.3\n  package_integrity:\n    npm: sha512-A+==\n\n- name: has/);
  const again = await planIntegrity(out.text, { npm: async () => assert.fail('idempotent') });
  assert.equal(again.added.length, 0);
});

test('planIntegrity reports missing packages and lookup errors', async () => {
  assert.match((await planIntegrity(REG, { npm: async () => ({ missing: true }) })).errors[0], /does not exist/);
  assert.match((await planIntegrity(REG, { npm: async () => { throw new Error('HTTP 500'); } })).errors[0], /HTTP 500/);
});

const entry = (integ, extra = {}) => ({ name: 'e', config: { command: ['npx', '-y', 'p@1.0.0'] }, package_integrity: integ, ...extra });
const ok = body => async () => ({ status: 200, json: async () => body });

test('package-exists compares package_integrity.npm to the index', async () => {
  assert.equal((await checkEntries([entry({ npm: SRI })], ok({ dist: { integrity: SRI } }))).missing.length, 0);
  const bad = await checkEntries([entry({ npm: SRI })], ok({ dist: { integrity: 'sha512-' + 'B'.repeat(86) + '==' } }));
  assert.match(bad.missing[0], /does not match the npm index/);
  assert.equal((await checkEntries([entry(undefined)], ok({ dist: { integrity: SRI } }))).missing.length, 0);
});

test('policy: changed or added npx entries need package_integrity.npm', () => {
  const errs = h => universalChecks({ baseMcps: [], headMcps: h }).filter(e => /package_integrity\.npm/.test(e));
  assert.equal(errs([entry(undefined)]).length, 1);
  assert.equal(errs([entry({ npm: SRI })]).length, 0);
  assert.equal(errs([{ name: 'u', config: { command: ['uvx', 'p==1.0'] } }]).length, 0);
});
