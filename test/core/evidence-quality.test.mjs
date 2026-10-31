import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreEvidence } from '../../master_brain/knowledge/evidence-quality.mjs';

test('scores evidence by quality, directness, independence and freshness', () => {
  const result = scoreEvidence({
    source_type: 'supplier_document',
    directness: 'DIRECT',
    methodology: 'DOCUMENTED',
    lineage_independent: true,
    freshness_days: 5,
  });
  assert.equal(result.status, 'USABLE');
  assert.ok(result.score >= 0.75);
});

test('does not treat social repetition as strong evidence', () => {
  const result = scoreEvidence({
    source_type: 'social_post',
    directness: 'INDIRECT',
    methodology: 'UNKNOWN',
    lineage_independent: false,
    freshness_days: 2,
  });
  assert.equal(result.status, 'WEAK');
  assert.ok(result.score < 0.5);
});

test('stale evidence is downgraded rather than silently discarded', () => {
  const result = scoreEvidence({
    source_type: 'supplier_document',
    directness: 'DIRECT',
    methodology: 'DOCUMENTED',
    lineage_independent: true,
    freshness_days: 900,
  });
  assert.equal(result.status, 'STALE');
  assert.ok(result.score < 0.75);
});
