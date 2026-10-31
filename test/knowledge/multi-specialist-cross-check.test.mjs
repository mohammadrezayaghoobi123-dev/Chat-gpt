import assert from 'node:assert/strict';
import test from 'node:test';
import { crossCheck } from '../../master_brain/knowledge/cross-check.mjs';

test('multi-specialist cross-check preserves model dependency, source lineage, and uncertainty', () => {
  const result = crossCheck([
    {
      specialist_id: 's1',
      model_id: 'model-a',
      claims: [{
        subject: 'X', predicate: 'status', value: 'valid',
        source_id: 'source-1', lineage_id: 'origin-1',
        uncertainty: ['measurement is noisy'],
      }],
    },
    {
      specialist_id: 's2',
      model_id: 'model-a',
      claims: [{
        subject: 'X', predicate: 'status', value: 'valid',
        source_id: 'source-1', lineage_id: 'origin-1',
        uncertainty: ['measurement is noisy'],
      }],
    },
    {
      specialist_id: 's3',
      model_id: 'model-b',
      claims: [{
        subject: 'X', predicate: 'status', value: 'invalid',
        source_id: 'source-2', lineage_id: 'origin-2',
        uncertainty: ['sample is small'],
      }],
    },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'CONFLICTED');
  assert.equal(result[0].agreement.independent_sources, 1);
  assert.equal(result[0].agreement.supporting_results, 2);
  assert.deepEqual(result[0].agreement.model_ids, ['model-a']);
  assert.deepEqual(result[0].agreement.lineage_ids, ['origin-1']);
  assert.deepEqual(result[0].agreement.uncertainties, ['measurement is noisy']);
  assert.equal(result[0].contradiction.independent_sources, 1);
  assert.deepEqual(result[0].contradiction.model_ids, ['model-b']);
  assert.deepEqual(result[0].contradiction.lineage_ids, ['origin-2']);
  assert.deepEqual(result[0].contradiction.uncertainties, ['sample is small']);
});
