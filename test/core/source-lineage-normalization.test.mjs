import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceRecord } from '../../master_brain/research/multi-source-intelligence.mjs';

test('normalizes lineage metadata so copied social content retains its origin', () => {
  const result = normalizeSourceRecord({
    platform: 'instagram',
    source_id: 'ig-copy-1',
    source_url: 'https://instagram.com/p/example',
    lineage_id: 'youtube-origin-1',
    lineage_type: 'REPOST',
    claims: [],
  });

  assert.equal(result.provenance.lineage_id, 'youtube-origin-1');
  assert.equal(result.provenance.lineage_type, 'REPOST');
  assert.equal(result.independence.key, 'lineage:youtube-origin-1');
});
