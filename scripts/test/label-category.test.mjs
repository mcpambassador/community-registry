// TD-056: the category labeller is a plain script now (was an inline github-script step that could not load js-yaml).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { labelsFor } from '../ci/label-category.mjs';

test('labelsFor: category, transport, auth and verified labels; unknown values ignored; prototype keys are not labels', () => {
  const l = labelsFor({ mcps: [
    { category: 'AI & ML', transport_type: 'stdio', auth_type: 'none' },
    { category: 'Developer Tools', transport_type: 'http', auth_type: 'oauth2', verified: true },
    { category: 'constructor', transport_type: '__proto__', auth_type: 'toString' },
    null,
  ] });
  assert.deepEqual(l.sort(), ['auth: none', 'auth: oauth2', 'category: ai-ml', 'category: developer-tools', 'registry-pr', 'transport: http', 'transport: stdio', 'verified-entry']);
  assert.deepEqual(labelsFor({}), ['registry-pr']);
  assert.deepEqual(labelsFor({ mcps: 'x' }), ['registry-pr']);
});

test('CLI --print works from plain node with the real registry.yaml (the original failure was a missing require.resolve)', () => {
  const r = spawnSync(process.execPath, ['scripts/ci/label-category.mjs', 'registry.yaml', '--print'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /registry-pr/);
});

test('CLI without --print rejects a non-numeric PR_NUMBER and never shells out', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lbl-')), 'r.yaml');
  fs.writeFileSync(f, 'mcps: []\n');
  const r = spawnSync(process.execPath, ['scripts/ci/label-category.mjs', f], { encoding: 'utf8', env: { ...process.env, PR_NUMBER: '1; rm -rf /' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PR_NUMBER must be a number/);
});

test('label-category workflow: base-sha code, PR head as data only, least privilege, no inline script', () => {
  const wf = yaml.load(fs.readFileSync(new URL('../../.github/workflows/label-category.yml', import.meta.url), 'utf8'));
  const on = wf.on ?? wf[true];
  assert.ok(on.pull_request && !on.pull_request_target);
  assert.deepEqual(wf.permissions, {});
  const job = wf.jobs['label-category'];
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'write' });
  assert.ok(!job.steps.some(s => /github-script/.test(s.uses ?? '')), 'no inline github-script');
  const base = job.steps.find(s => s.with?.path === 'base');
  assert.equal(base.with.ref, '${{ github.event.pull_request.base.sha }}');
  const install = job.steps.find(s => /npm ci/.test(s.run ?? ''));
  assert.match(install.run, /^cd base && npm ci --ignore-scripts/);
  const run = job.steps.find(s => /label-category\.mjs/.test(s.run ?? ''));
  assert.match(run.run, /node base\/scripts\/ci\/label-category\.mjs head\/registry\.yaml/);
  assert.ok(!/\$\{\{/.test(run.run), 'no expression interpolation in the command');
  for (const s of job.steps) if (s.run) assert.doesNotMatch(s.run, /head\/(scripts|node_modules)/, 'never run code from the PR checkout');
});
