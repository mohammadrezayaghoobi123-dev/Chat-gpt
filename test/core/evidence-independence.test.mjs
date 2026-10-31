import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEvidence } from '../../master_brain/knowledge/evidence-aggregator.mjs';

test('evidence aggregation counts source lineage, not repost copies, as independent evidence', () => {
  const result = aggregateEvidence([
    {
      claims: [{
        subject: 'machine-A',
        predicate: 'capacity',
        value: '1000kg/day',
        source_id: 'yt-1',
        lineage_id: 'origin-A',
      }],
    },
    {
      claims: [{
        subject: 'machine-A',
        predicate: 'capacity',
        value: '1000kg/day',
        source_id: 'ig-1',
        lineage_id: 'origin-A',
      }],
    },
    {
      claims: [{
        subject: 'machine-A',
        predicate: 'capacity',
        value: '1000kg/day',
        source_id: 'supplier-doc-1',
        lineage_id: 'origin-B',
      }],
    },
  ]);

  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].supporting_results, 3);
  assert.equal(result.claims[0].independent_sources, 2);
});
