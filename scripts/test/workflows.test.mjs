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

test('sync-official-registry: two-job split, dry_run default, weekly schedule that is always a dry run, privileged job runs no npm', () => {
  const wf = yaml.load(fs.readFileSync(path.join(dir, 'sync-official-registry.yml'), 'utf8'));
  const on = wf.on ?? wf[true];
  assert.equal(on.workflow_dispatch.inputs.dry_run.default, true, 'dry_run must default to true');
  assert.deepEqual(on.schedule, [{ cron: '17 6 * * 1' }], 'weekly Monday schedule (ADR-024 §7)');
  assert.deepEqual(wf.permissions, {}, 'top-level permissions must be empty');
  const { prepare, ['open-pr']: open } = wf.jobs;
  assert.deepEqual(prepare.permissions, { contents: 'read' });
  assert.equal(open.environment, 'registry-sync');
  assert.deepEqual(open.permissions, { contents: 'read' });
  assert.match(prepare.if, /refs\/heads\/main/);
  assert.match(open.if, /dry_run == false/);
  assert.match(open.if, /github\.event_name == 'workflow_dispatch'/, 'a scheduled run (inputs.dry_run null == false) must never reach the privileged job');
  const build = prepare.steps.find(s => s.id === 'sync');
  assert.match(build.run, /\[ "\$EVENT_NAME" = "schedule" \] \|\| \[ "\$DRY_RUN" = "true" \]; then flags="--dry-run"/, 'schedule forces --dry-run');
  assert.match(build.run, /EVENT_NAME" = "schedule" \] && \[ "\$\(\(10#\$\(date -u \+%d\)\)\)" -le 7 \]; then flags="\$flags --full-scan"/, 'first-Monday full scan');
  assert.equal(build.env.EVENT_NAME, '${{ github.event_name }}');
  assert.equal(build.env.GITHUB_TOKEN, '${{ github.token }}');
  for (const [n, j] of Object.entries(wf.jobs)) for (const st of j.steps) if (st !== build) assert.ok(!st.env || !('GITHUB_TOKEN' in st.env), `${n}: the token reaches only the sync step`);
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

test('validate-registry: policy checker runs from the base ref in its own job, failing closed (B1)', () => {
  const wf = yaml.load(fs.readFileSync(path.join(dir, 'validate-registry.yml'), 'utf8'));
  const job = wf.jobs['policy-checks'];
  assert.ok(job, 'policy-checks job exists');
  assert.deepEqual(job.permissions, { contents: 'read' });
  const base = job.steps.find(s => s.uses?.startsWith('actions/checkout@') && s.with?.path === 'base');
  assert.ok(base, 'checkout with path: base');
  assert.equal(base.with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(base.with['persist-credentials'], false);
  const head = job.steps.find(s => s.uses?.startsWith('actions/checkout@') && s.with?.path === 'head');
  assert.ok(head && head.with['persist-credentials'] === false, 'head checkout is data-only');
  const policy = job.steps.find(s => /check\.mjs/.test(s.run ?? ''));
  const run = policy.run;
  // base checker preferred; PR-supplied checker only when the PR adds it; otherwise hard failure
  assert.match(run, /if \[ -f base\/scripts\/ci\/check\.mjs \]/);
  assert.match(run, /--diff-filter=A[^\n]*\| grep -qx scripts\/ci\/check\.mjs/);
  assert.match(run, /::error::[\s\S]*exit 1/);
  assert.match(run, /::warning::/);
  assert.match(run, /node "\$CHECKER_DIR\/scripts\/ci\/check\.mjs"/);
  // the head's dependencies are installed only in the bootstrap branch
  assert.equal((run.match(/cd head && npm ci/g) ?? []).length, 1);
  assert.ok(run.indexOf('cd base && npm ci') < run.indexOf('cd head && npm ci'));
  // no other job runs the checker from the head
  for (const [n, j] of Object.entries(wf.jobs)) {
    if (n === 'policy-checks') continue;
    for (const st of j.steps ?? []) assert.doesNotMatch(st.run ?? '', /scripts\/ci\/check\.mjs/, `${n} must not run the checker`);
  }
});
