import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSourceIndependence } from '../../master_brain/research/multi-source-intelligence.mjs';

test('treats reposts with the same lineage as one independent source', () => {
  const result = assessSourceIndependence([
    { source_id: 'yt-1', platform: 'youtube', lineage_id: 'origin-A', lineage_type: 'ORIGINAL' },
    { source_id: 'ig-1', platform: 'instagram', lineage_id: 'origin-A', lineage_type: 'REPOST' },
    { source_id: 'tg-1', platform: 'telegram', lineage_id: 'origin-A', lineage_type: 'COPY' },
    { source_id: 'paper-1', platform: 'paper', lineage_id: 'origin-B', lineage_type: 'ORIGINAL' },
  ]);

  assert.equal(result.independent_sources, 2);
  assert.deepEqual(result.lineages.sort(), ['origin-A', 'origin-B']);
});

test('keeps unrelated sources independent when lineage is unknown', () => {
  const result = assessSourceIndependence([
    { source_id: 'yt-1', platform: 'youtube' },
    { source_id: 'web-1', platform: 'web' },
  ]);

  assert.equal(result.independent_sources, 2);
});
