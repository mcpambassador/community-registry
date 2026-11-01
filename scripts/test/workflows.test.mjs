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
