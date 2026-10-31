import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContradiction } from '../../master_brain/knowledge/contradiction-resolution.mjs';

test('prefers stronger independent evidence but keeps the contradiction visible', () => {
  const result = resolveContradiction({
    claims: [
      { value: '1000', evidence_score: 0.88, source_id: 'A', lineage_id: 'A' },
      { value: '700', evidence_score: 0.61, source_id: 'B', lineage_id: 'B' },
    ],
  });

  assert.equal(result.status, 'TENTATIVELY_RESOLVED');
  assert.equal(result.preferred_value, '1000');
  assert.equal(result.contradiction_preserved, true);
});

test('does not resolve when evidence quality is effectively tied', () => {
  const result = resolveContradiction({
    claims: [
      { value: '1000', evidence_score: 0.76, source_id: 'A', lineage_id: 'A' },
      { value: '700', evidence_score: 0.75, source_id: 'B', lineage_id: 'B' },
    ],
  });

  assert.equal(result.status, 'UNRESOLVED');
  assert.equal(result.preferred_value, null);
});

test('does not let duplicate lineage amplify evidence strength', () => {
  const result = resolveContradiction({
    claims: [
      { value: '1000', evidence_score: 0.7, source_id: 'A', lineage_id: 'origin-1' },
      { value: '1000', evidence_score: 0.7, source_id: 'B', lineage_id: 'origin-1' },
      { value: '700', evidence_score: 0.8, source_id: 'C', lineage_id: 'origin-2' },
    ],
  });

  assert.equal(result.preferred_value, '700');
  assert.equal(result.status, 'TENTATIVELY_RESOLVED');
});
