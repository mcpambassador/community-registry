import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const dir = new URL('../../.github/workflows/', import.meta.url).pathname;
const files = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f));
const SHA = /^[^@\s]+@[0-9a-f]{40}$/;

test('there are workflows to lint', () => assert.ok(files.length > 0));

for (const f of files) {
  const wf = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
  test(`${f}: hardened (SHA-pinned actions, top-level permissions, no pull_request_target)`, () => {
    const on = wf.on ?? wf[true];
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
    assert.ok(!triggers.includes('pull_request_target'), 'pull_request_target is forbidden (ADR-024)');
    assert.ok(Object.prototype.hasOwnProperty.call(wf, 'permissions'), 'top-level permissions required');
    for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        assert.match(step.uses, SHA, `${jobName}: "${step.uses}" must be pinned to a full commit SHA`);
        if (step.uses.startsWith('actions/checkout@')) {
          assert.equal(step.with?.['persist-credentials'], false, `${jobName}: checkout needs persist-credentials: false`);
        }
      }
    }
  });
}

test('sync-official-registry: two-job split, dry_run default, no schedule, privileged job runs no npm', () => {
  const wf = yaml.load(fs.readFileSync(path.join(dir, 'sync-official-registry.yml'), 'utf8'));
  const on = wf.on ?? wf[true];
  assert.equal(on.workflow_dispatch.inputs.dry_run.default, true, 'dry_run must default to true');
  assert.ok(!('schedule' in on), 'no active schedule until a reviewed dry run (ADR-024 §7)');
  assert.deepEqual(wf.permissions, {}, 'top-level permissions must be empty');
  const { prepare, ['open-pr']: open } = wf.jobs;
  assert.deepEqual(prepare.permissions, { contents: 'read' });
  assert.equal(open.environment, 'registry-sync');
  assert.deepEqual(open.permissions, { contents: 'read' });
  assert.match(prepare.if, /refs\/heads\/main/);
  assert.match(open.if, /dry_run == false/);
  for (const s of open.steps) {
    assert.ok(!/setup-node/.test(s.uses ?? ''), 'open-pr must not set up node tooling');
    assert.ok(!/\b(npm|npx|pnpm|yarn)\b/.test(s.run ?? ''), 'open-pr must not run npm');
  }
  const app = open.steps.find(s => /create-github-app-token/.test(s.uses ?? ''));
  assert.equal(app.with['permission-contents'], 'write');
  assert.equal(app.with['permission-pull-requests'], 'write');
  assert.ok(!Object.keys(app.with).some(k => /workflows/.test(k)), 'no workflows permission');
  for (const s of open.steps) assert.ok(!/\$\{\{\s*steps\.app\.outputs\.token\s*\}\}/.test(s.run ?? ''), 'token must not appear in a command line');
});

test('validate-registry: the policy checker runs from the base ref, not the PR head (B1)', () => {
  const wf = yaml.load(fs.readFileSync(path.join(dir, 'validate-registry.yml'), 'utf8'));
  const steps = Object.values(wf.jobs).flatMap(j => j.steps ?? []);
  const base = steps.find(s => s.uses?.startsWith('actions/checkout@') && s.with?.path === 'base');
  assert.ok(base, 'a second checkout with path: base is required');
  assert.equal(base.with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(base.with['persist-credentials'], false);
  const policy = steps.find(s => /scripts\/ci\/check\.mjs/.test(s.run ?? ''));
  assert.ok(policy, 'policy step exists');
  assert.match(policy.run, /node base\/scripts\/ci\/check\.mjs/);
  assert.doesNotMatch(policy.run, /node scripts\/ci\/check\.mjs/);
});
