// TD-056: the category labeller is a plain script now (was an inline github-script step that could not load js-yaml).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { labelsFor, CATEGORY_LABELS } from '../ci/label-category.mjs';

const e = (name, over = {}) => ({ name, category: 'Productivity', transport_type: 'stdio', auth_type: 'none', ...over });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbl-'));
const write = (n, o) => { const f = path.join(tmp, n); fs.writeFileSync(f, yaml.dump(o)); return f; };

test('labelsFor: an unchanged file gets only registry-pr', () => {
  const doc = { mcps: [e('a'), e('b', { category: 'Business', auth_type: 'oauth2', verified: true })] };
  assert.deepEqual(labelsFor(doc, structuredClone(doc)), ['registry-pr']);
});

test('labelsFor: one added entry gets exactly its labels, not the existing entries\'', () => {
  const base = { mcps: [e('a', { category: 'Business', transport_type: 'http', auth_type: 'oauth2' })] };
  const head = { mcps: [...base.mcps, e('b', { category: 'Developer Tools', verified: true })] };
  assert.deepEqual(labelsFor(head, base).sort(), ['auth: none', 'category: developer-tools', 'registry-pr', 'transport: stdio', 'verified-entry']);
});

test('labelsFor: a changed entry gets its new labels; a removed entry adds none', () => {
  const base = { mcps: [e('a'), e('b', { category: 'Business' })] };
  const head = { mcps: [e('a', { category: 'Data & Search', auth_type: 'static' })] };
  assert.deepEqual(labelsFor(head, base).sort(), ['auth: static', 'category: data-search', 'registry-pr', 'transport: stdio']);
});

test('labelsFor: Uncategorized maps; unknown values and prototype keys are ignored; junk docs are safe', () => {
  assert.ok(labelsFor({ mcps: [e('a', { category: 'Uncategorized' })] }, {}).includes('category: uncategorized'));
  assert.deepEqual(labelsFor({ mcps: [e('a', { category: 'constructor', transport_type: '__proto__', auth_type: 'toString' }), null] }, {}), ['registry-pr']);
  assert.deepEqual(labelsFor({}, {}), ['registry-pr']);
  assert.deepEqual(labelsFor({ mcps: 'x' }, null), ['registry-pr']);
});

test('every category in registry.yaml has a label', () => {
  const doc = yaml.load(fs.readFileSync(new URL('../../registry.yaml', import.meta.url), 'utf8'));
  for (const m of doc.mcps) assert.ok(CATEGORY_LABELS[m.category], `no label for category "${m.category}"`);
});

const cli = (args, env = {}) => spawnSync(process.execPath, ['scripts/ci/label-category.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('CLI --print against the real registry.yaml vs itself: only registry-pr', () => {
  const r = cli(['registry.yaml', '--base', 'registry.yaml', '--print']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'registry-pr');
});

test('CLI rejects a missing --base and a non-numeric PR_NUMBER (never shells out)', () => {
  const f = write('h.yaml', { mcps: [] });
  assert.notEqual(cli([f]).status, 0);
  const r = cli([f, '--base', f], { PR_NUMBER: '1; rm -rf /' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PR_NUMBER must be a number/);
});

// A mocked gh that logs its argv and fails `pr edit` when GH_FAIL=1.
const ghMock = path.join(tmp, 'gh');
fs.writeFileSync(ghMock, '#!/bin/sh\necho "$@" >> "$GH_LOG"\nif [ "$1 $2" = "pr edit" ] && [ "$GH_FAIL" = 1 ]; then echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; fi\n', { mode: 0o755 });

test('label failure: fails the job on a same-repo PR, only warns on a fork PR; success applies the labels', () => {
  const base = write('b.yaml', { mcps: [e('a')] });
  const head = write('h2.yaml', { mcps: [e('a'), e('b', { category: 'Business' })] });
  const log = path.join(tmp, 'gh.log');
  const env = { PR_NUMBER: '7', LABEL_GH_BIN: ghMock, GH_LOG: log };
  fs.writeFileSync(log, '');
  const ok = cli([head, '--base', base], { ...env, IS_FORK: 'false' });
  assert.equal(ok.status, 0, ok.stderr);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /^pr edit 7 --add-label registry-pr,category: business,transport: stdio,auth: none$/m);
  const same = cli([head, '--base', base], { ...env, IS_FORK: 'false', GH_FAIL: '1' });
  assert.equal(same.status, 1);
  assert.match(same.stderr, /::error::could not label #7/);
  const fork = cli([head, '--base', base], { ...env, IS_FORK: 'true', GH_FAIL: '1' });
  assert.equal(fork.status, 0);
  assert.match(fork.stdout, /::warning::could not label #7 \(fork PR/);
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
  assert.ok(!job.steps.some(s => /\bnpm\b/.test(s.run ?? '')), 'vendored js-yaml: no npm install in this job');
  const run = job.steps.find(s => /label-category\.mjs/.test(s.run ?? ''));
  assert.match(run.run, /node base\/scripts\/ci\/label-category\.mjs head\/registry\.yaml --base base\/registry\.yaml/);
  assert.equal(run.env.IS_FORK, '${{ github.event.pull_request.head.repo.full_name != github.repository }}');
  assert.ok(!on.workflow_run && !on.pull_request_target);
  assert.ok(!/\$\{\{/.test(run.run), 'no expression interpolation in the command');
  for (const s of job.steps) if (s.run) assert.doesNotMatch(s.run, /head\/(scripts|node_modules)/, 'never run code from the PR checkout');
});
