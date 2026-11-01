import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'runner-guard.mjs');

// Drift pin (TD-043). To re-vendor: transpile the server's runner-guard.ts at the new commit, update the
// provenance header and PINNED_COMMIT, then replace EXPECTED_SHA256 with the value this test prints.
const PINNED_COMMIT = '328dd5f';
const EXPECTED_SHA256 = 'afb88b23e0aafd20aa0a22124391062abe94e261844eb5802b95e47716dd6d31';

test('vendored runner-guard.mjs is pinned to its server commit and content hash (TD-043)', () => {
  const text = fs.readFileSync(file, 'utf8');
  const header = text.split('\n')[0];
  assert.ok(header.includes(`@ ${PINNED_COMMIT} `), `provenance header must name server commit ${PINNED_COMMIT}`);
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(sha, EXPECTED_SHA256, `vendored file changed (sha256 ${sha}); re-vendor from the server and update the pin`);
});
