import assert from 'node:assert/strict';
import test from 'node:test';
import { devilAdvocate } from '../../master_brain/knowledge/devil-advocate.mjs';

test('devil advocate challenges the leading claim using contrary specialist evidence', () => {
  const result = devilAdvocate([
    { agent_id: 'a', claims: [{ subject: 'X', predicate: 'status', value: 'valid', source_id: 's1' }] },
    { agent_id: 'b', claims: [{ subject: 'X', predicate: 'status', value: 'valid', source_id: 's2' }] },
    { agent_id: 'c', claims: [{ subject: 'X', predicate: 'status', value: 'invalid', source_id: 's3' }] },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].leading_value, 'valid');
  assert.equal(result[0].challenge.status, 'CHALLENGED');
  assert.equal(result[0].challenge.value, 'invalid');
  assert.equal(result[0].challenge.supporting_results, 1);
});

test('devil advocate marks uncontested claims as unchallenged rather than inventing objections', () => {
  const result = devilAdvocate([
    { agent_id: 'a', claims: [{ subject: 'X', predicate: 'status', value: 'valid', source_id: 's1' }] },
  ]);

  assert.equal(result[0].challenge.status, 'UNCHALLENGED');
  assert.equal(result[0].challenge.value, undefined);
});
