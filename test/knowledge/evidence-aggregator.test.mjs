import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateEvidence } from '../../master_brain/knowledge/evidence-aggregator.mjs';

test('aggregates specialist claims and counts independent sources without double-counting shared sources', () => {
  const result = aggregateEvidence([
    { agent_id: 'agent-a', claims: [{ subject: 'X', predicate: 'status', value: 'valid', source_id: 'source-1' }] },
    { agent_id: 'agent-b', claims: [{ subject: 'X', predicate: 'status', value: 'valid', source_id: 'source-1' }] },
    { agent_id: 'agent-c', claims: [{ subject: 'X', predicate: 'status', value: 'valid', source_id: 'source-2' }] },
  ]);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].supporting_results, 3);
  assert.equal(result.claims[0].independent_sources, 2);
  assert.deepEqual(result.claims[0].source_ids.sort(), ['source-1', 'source-2']);
});
