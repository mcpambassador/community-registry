import test from 'node:test';
import assert from 'node:assert/strict';
import { isSyncPr, pinProblem, lintEntryText, universalChecks, diffScope } from '../lib/checks.mjs';

const entry = (over = {}) => ({
  name: 'a-thing', display_name: 'A Thing', description: 'does things', transport_type: 'stdio',
  config: { command: ['npx', '-y', 'a-thing@1.2.3'] }, auth_type: 'none', ...over,
});
const synced = (over = {}) => entry({ source: 'official-registry', verified: false, ...over });

test('sync PR detection: branch prefix or the sync App author, never a label', () => {
  assert.equal(isSyncPr({ headRef: 'sync/official-2026-11-08' }), true);
  assert.equal(isSyncPr({ headRef: 'feature/x', author: 'reg-sync[bot]', appLogin: 'reg-sync[bot]' }), true);
  assert.equal(isSyncPr({ headRef: 'feature/x', author: 'someone', appLogin: 'reg-sync[bot]' }), false);
  assert.equal(isSyncPr({ headRef: 'feature/x', author: 'someone', appLogin: '' }), false);
  assert.equal(isSyncPr({ headRef: 'xsync/official-1' }), false);
});

test('pins: exact accepted, floating rejected', () => {
  for (const ok of [
    ['npx', '-y', 'pkg@1.2.3'], ['npx', '-y', '@scope/pkg@0.1.0'], ['npx', '--yes', 'pkg@1.0.0-beta.1'],
    ['uvx', 'pkg==1.2.3'], ['uvx', 'my_pkg[extra]==2.0'], ['uvx', 'pkg==1.0.0rc1'], ['docker', 'run', 'x'], ['node', 'a.js'],
  ]) assert.equal(pinProblem(ok), null, ok.join(' '));
  for (const bad of [
    ['npx', '-y', 'pkg'], ['npx', '-y', 'pkg@latest'], ['npx', '-y', 'pkg@^1.2.3'], ['npx', '-y', 'pkg@~1.2.3'],
    ['npx', '-y', 'pkg@1'], ['npx', '-y', 'pkg@1.2'], ['npx', '-y', '@scope/pkg'], ['npx', '-y'],
    ['uvx', 'pkg'], ['uvx', 'pkg>=1'], ['uvx', 'pkg==1.*'], ['uvx', 'pkg~=1.2'], ['uvx', 'pkg@latest'],
  ]) assert.notEqual(pinProblem(bad), null, bad.join(' '));
});

test('text lint: control, zero-width, bidi, non-https URL', () => {
  assert.deepEqual(lintEntryText(entry({ description: 'plain\tfine\nok' })), []);
  for (const ch of ['\u0000', '\u0007', '​', '‎', '‮', '⁦', '﻿', ' ', '\u009F']) {
    assert.equal(lintEntryText(entry({ description: `a${ch}b` })).length, 1, JSON.stringify(ch));
  }
  assert.equal(lintEntryText(entry({ display_name: `A${'​'}` })).length, 1);
  assert.equal(lintEntryText(entry({ description: 'see http://evil.example/x' })).length, 1);
  assert.deepEqual(lintEntryText(entry({ description: 'see https://ok.example/x' })), []);
});

test('universal: verified cannot be true on an added entry; existing entries may stay verified', () => {
  const base = [entry({ name: 'old', verified: true })];
  assert.equal(universalChecks({ baseMcps: base, headMcps: [...base, entry({ verified: true })] }).length, 1);
  assert.deepEqual(universalChecks({ baseMcps: base, headMcps: [...base, entry({ verified: false })] }), []);
  assert.deepEqual(universalChecks({ baseMcps: base, headMcps: base }), []);
});

test('universal: pins enforced on added/changed entries; all-pins covers the whole file', () => {
  const unpinned = entry({ name: 'old', config: { command: ['uvx', 'old-pkg'] } });
  assert.deepEqual(universalChecks({ baseMcps: [unpinned], headMcps: [unpinned] }), []);
  assert.equal(universalChecks({ baseMcps: [unpinned], headMcps: [unpinned], allPins: true }).length, 1);
  assert.equal(universalChecks({ baseMcps: [unpinned], headMcps: [{ ...unpinned, description: 'changed' }] }).length, 1);
  assert.equal(universalChecks({ baseMcps: [], headMcps: [entry({ config: { command: ['npx', '-y', 'a-thing'] } })] }).length, 1);
});

test('universal: lint applies to changed entries', () => {
  assert.equal(universalChecks({ baseMcps: [], headMcps: [entry({ description: 'x‮y' })] }).length, 1);
});

const R = ['registry.yaml'];
test('diff-scope: a clean additive sync passes', () => {
  assert.deepEqual(diffScope({ baseMcps: [entry({ name: 'x', source: undefined })], headMcps: [entry({ name: 'x', source: undefined }), synced()], changedFiles: R }), []);
});
test('diff-scope: only registry.yaml may change', () => {
  assert.equal(diffScope({ baseMcps: [], headMcps: [synced()], changedFiles: ['registry.yaml', '.github/workflows/x.yml'] }).length, 1);
  assert.equal(diffScope({ baseMcps: [], headMcps: [synced()], changedFiles: ['schema/registry.schema.json'] }).length, 1);
  assert.equal(diffScope({ baseMcps: [], headMcps: [synced()], changedFiles: [] }).length, 1);
});
test('diff-scope: deletions rejected', () => {
  assert.equal(diffScope({ baseMcps: [entry()], headMcps: [], changedFiles: R }).length, 1);
});
test('diff-scope: added entries need source, no oauth_config, no verified, no stray fields', () => {
  assert.equal(diffScope({ baseMcps: [], headMcps: [entry()], changedFiles: R }).length, 1);
  assert.ok(diffScope({ baseMcps: [], headMcps: [synced({ oauth_config: { auth_url: 'https://a', token_url: 'https://b' } })], changedFiles: R }).length >= 1);
  assert.ok(diffScope({ baseMcps: [], headMcps: [synced({ verified: true })], changedFiles: R }).length >= 1);
  assert.equal(diffScope({ baseMcps: [], headMcps: [synced({ command_override: 'x' })], changedFiles: R }).length, 1);
});
test('diff-scope: allowed edits of an official-registry entry', () => {
  const b = synced({ version: '1.2.3', synced_at: '2026-11-01T00:00:00Z' });
  const h = synced({
    version: '1.2.4', synced_at: '2026-11-08T00:00:00Z', description: 'new text', package_integrity: { npm: 'sha512-AAA=' },
    config: { command: ['npx', '-y', 'a-thing@1.2.4'], env: { K: 'v' } },
  });
  assert.deepEqual(diffScope({ baseMcps: [b], headMcps: [h], changedFiles: R }), []);
});
test('diff-scope: forbidden edits', () => {
  const b = synced();
  const bad = {
    'transport_type': { ...b, transport_type: 'http' },
    'config.url': { ...b, config: { ...b.config, url: 'https://x/mcp' } },
    'verified': { ...b, verified: true },
    'auth_type': { ...b, auth_type: 'static' },
    'isolation_mode': { ...b, isolation_mode: 'per_user' },
    'oauth_config': { ...b, oauth_config: { auth_url: 'https://a', token_url: 'https://b' } },
    'name': { ...b, name: 'other' },
    'package swap': { ...b, config: { command: ['npx', '-y', 'evil-pkg@1.0.0'] } },
    'extra arg': { ...b, config: { command: ['npx', '-y', 'a-thing@1.2.3', '--registry=https://evil'] } },
    'runner swap': { ...b, config: { command: ['uvx', 'a-thing==1.2.3'] } },
  };
  for (const [what, h] of Object.entries(bad)) {
    const res = diffScope({ baseMcps: [b], headMcps: [h], changedFiles: R });
    assert.ok(res.length >= 1, `${what} should be rejected`);
  }
});
test('diff-scope: manual entries cannot be edited by sync', () => {
  const b = entry();
  assert.equal(diffScope({ baseMcps: [b], headMcps: [{ ...b, description: 'x' }], changedFiles: R }).length, 1);
});

test('runner guard (TD-043): runner-changing flags and reserved env names are rejected', () => {
  const run = over => universalChecks({ baseMcps: [], headMcps: [entry(over)] });
  const cmd = (...c) => ({ config: { command: c } });
  assert.deepEqual(run({}), []);
  assert.deepEqual(run(cmd('npx', '-y', 'a-thing@1.2.3', '-p', '8080')), []);
  assert.notEqual(run(cmd('npx', '-y', '--registry=https://evil.example', 'a-thing@1.2.3')).length, 0);
  assert.notEqual(run(cmd('uvx', '--index-url', 'https://evil.example', 'a-thing==1.2.3')).length, 0);
  const withEnv = env => ({ config: { command: ['npx', '-y', 'a-thing@1.2.3'], env } });
  assert.equal(run(withEnv({ NPM_CONFIG_REGISTRY: 'x' })).length, 1);
  assert.equal(run(withEnv({ NODE_OPTIONS: '--require x' })).length, 1);
  assert.equal(run({ credential_schema: { properties: { LD_PRELOAD: { type: 'string' } } } }).length, 1);
  assert.deepEqual(run(withEnv({ NODE_ENV: 'production' })), []);
});

test('credential_schema may not bind an env var that config.env fixes (TD-049)', () => {
  const alpaca = (schemaProps, env) => entry({
    config: { command: ['uvx', 'alpaca-mcp-server==2.4.0'], env },
    credential_schema: { type: 'object', properties: schemaProps },
  });
  const base = [];
  const ok = alpaca(
    { ALPACA_API_KEY: { type: 'string', env_var: 'ALPACA_API_KEY' } },
    { ALPACA_PAPER_TRADE: 'true' }
  );
  assert.deepEqual(universalChecks({ baseMcps: base, headMcps: [ok] }), []);
  // by key, by env_var, and case-insensitively
  for (const props of [
    { ALPACA_PAPER_TRADE: { type: 'string' } },
    { PAPER: { type: 'string', env_var: 'ALPACA_PAPER_TRADE' } },
    { alpaca_paper_trade: { type: 'string' } },
  ]) {
    const errs = universalChecks({ baseMcps: base, headMcps: [alpaca(props, { ALPACA_PAPER_TRADE: 'true' })] });
    assert.ok(errs.some(e => /config\.env fixes/.test(e)), JSON.stringify(props));
  }
  // `KEY: ${KEY}` is a same-name placeholder, not a fixed value
  const placeholder = alpaca({ TOKEN: { type: 'string' } }, { TOKEN: '${TOKEN}' });
  assert.deepEqual(universalChecks({ baseMcps: base, headMcps: [placeholder] }), []);
});

test('locked env names cannot be bound by credential_schema, even without a fixed config.env key', () => {
  const mk = props => entry({ credential_schema: { type: 'object', properties: props } });
  assert.deepEqual(universalChecks({ baseMcps: [], headMcps: [mk({ ALPACA_API_KEY: { type: 'string' } })] }), []);
  for (const props of [
    { ALPACA_PAPER_TRADE: { type: 'string' } },
    { alpaca_toolsets: { type: 'string' } },
    { U: { type: 'string', env_var: 'Data_Api_Url' } },
  ]) {
    const errs = universalChecks({ baseMcps: [], headMcps: [mk(props)] });
    assert.ok(errs.some(e => /locked environment variable/.test(e)), JSON.stringify(props));
  }
});
