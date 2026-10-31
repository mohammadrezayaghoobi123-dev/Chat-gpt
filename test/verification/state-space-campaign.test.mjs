import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateCriticalStateSpace } from '../../master_brain/verification/harness/mutation-campaign.mjs';

test('critical state-space denominator matches the Cartesian product of declared dimensions', () => {
  const result = enumerateCriticalStateSpace();
  assert.equal(result.total, 8);
  assert.equal(result.covered, 8);
  assert.equal(result.unsafe, 0);
});
