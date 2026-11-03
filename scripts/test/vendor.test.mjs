import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'runner-guard.mjs');

// Drift pin (TD-043). To re-vendor: transpile the server's runner-guard.ts at the new commit, update the
// provenance header and PINNED_COMMIT, then replace EXPECTED_SHA256 with the value this test prints.
const PINNED_COMMIT = '3a67aaf';
const EXPECTED_SHA256 = 'dc4de56da71ddbb8b97733d6f3e3ae7a3ad7ae9a29ad3d414f6589a6d26afcd6';

test('vendored runner-guard.mjs is pinned to its server commit and content hash (TD-043)', () => {
  const text = fs.readFileSync(file, 'utf8');
  const header = text.split('\n')[0];
  assert.ok(header.includes(`@ ${PINNED_COMMIT} `), `provenance header must name server commit ${PINNED_COMMIT}`);
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(sha, EXPECTED_SHA256, `vendored file changed (sha256 ${sha}); re-vendor from the server and update the pin`);
});
