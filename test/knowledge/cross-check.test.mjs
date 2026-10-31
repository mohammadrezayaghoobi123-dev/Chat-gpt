import assert from 'node:assert/strict';
import test from 'node:test';
import { crossCheck } from '../../master_brain/knowledge/cross-check.mjs';

test('cross-check identifies agreement and contradiction between claim values', () => {
  const result = crossCheck([
    { agent_id: 'a', claims: [{ subject: 'X', predicate: 'status', value: 'valid', source_id: 's1' }] },
    { agent_id: 'b', claims: [{ subject: 'X', predicate: 'status', value: 'valid', source_id: 's2' }] },
    { agent_id: 'c', claims: [{ subject: 'X', predicate: 'status', value: 'invalid', source_id: 's3' }] },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'CONFLICTED');
  assert.deepEqual(result[0].values.sort(), ['invalid', 'valid']);
  assert.equal(result[0].agreement.supporting_results, 2);
  assert.equal(result[0].contradiction.supporting_results, 1);
});
