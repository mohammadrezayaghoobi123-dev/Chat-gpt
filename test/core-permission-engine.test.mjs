import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../master_brain/core/permission-engine.mjs';

test('requires explicit approval for critical risk', () => {
  const result = authorize({ risk: 'CRITICAL', decision: 'PROCEED' });
  assert.equal(result.level, 'L3');
  assert.equal(result.allowed, false);
  assert.equal(result.requires_approval, true);
});

test('allows low-risk recommendation without execution permission', () => {
  const result = authorize({ risk: 'LOW', decision: 'PROCEED' });
  assert.equal(result.level, 'L1');
  assert.equal(result.allowed, true);
  assert.equal(result.requires_approval, false);
});
