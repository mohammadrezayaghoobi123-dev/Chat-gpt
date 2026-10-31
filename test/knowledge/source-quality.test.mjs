import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateSourceQuality } from '../../master_brain/knowledge/source-quality.mjs';

test('evaluates source quality using authority, freshness, independence and methodology', () => {
  const result = evaluateSourceQuality({
    authority: 0.9,
    freshness: 0.8,
    independence: 0.7,
    methodology: 0.6,
  });

  assert.equal(result.score, 0.75);
  assert.equal(result.band, 'STRONG');
});

test('rejects out-of-range source quality dimensions', () => {
  assert.throws(
    () => evaluateSourceQuality({ authority: 1.1, freshness: 0.8, independence: 0.7, methodology: 0.6 }),
    /authority/i,
  );
});
