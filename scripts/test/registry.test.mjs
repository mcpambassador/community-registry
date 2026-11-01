import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = new URL('../../', import.meta.url);
const schema = JSON.parse(fs.readFileSync(new URL('schema/registry.schema.json', root), 'utf8'));
const registry = yaml.load(fs.readFileSync(new URL('registry.yaml', root), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

test('registry.yaml validates against the schema', () => {
  assert.ok(validate(registry), JSON.stringify(validate.errors));
});

const provenance = {
  source: 'official-registry', official_name: 'io.github.acme/thing', namespace_verification: 'github',
  package_integrity: { npm: 'sha512-abc+/=' , pypi: ['a'.repeat(64)] }, dependencies_pinned: false, pinning: 'none',
  flags: ['new-package', 'name-near-match'], synced_at: '2026-11-08T00:00:00Z',
};
const base = registry.mcps[0];
const withEntry = extra => ({ ...registry, mcps: [{ ...base, ...extra }] });

test('provenance fields validate', () => assert.ok(validate(withEntry(provenance)), JSON.stringify(validate.errors)));

for (const [what, extra] of Object.entries({
  'unknown source': { source: 'scraped' }, 'bad integrity': { package_integrity: { npm: 'md5-x' } },
  'extra integrity key': { package_integrity: { cargo: 'x' } }, 'bad pypi hash': { package_integrity: { pypi: ['zz'] } },
  'bad flag': { flags: ['Not Kebab'] }, 'bad synced_at': { synced_at: 'yesterday' }, 'bad pinning': { pinning: 'exact' },
})) test(`schema rejects: ${what}`, () => assert.equal(validate(withEntry(extra)), false));
