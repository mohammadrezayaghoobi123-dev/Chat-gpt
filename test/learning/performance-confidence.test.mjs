import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPerformanceConfidence } from '../../master_brain/learning/performance-confidence.mjs';

test('downgrades confidence when performance has too few observations', () => {
  const result = assessPerformanceConfidence({ count: 2, accuracy: 1, freshness: 1 });
  assert.equal(result.band, 'LOW');
});

test('recognizes strong performance with sufficient observations and fresh data', () => {
  const result = assessPerformanceConfidence({ count: 50, accuracy: 0.94, freshness: 0.95 });
  assert.equal(result.band, 'HIGH');
  assert.ok(result.score > 0.8);
});

test('rejects invalid performance inputs', () => {
  assert.throws(() => assessPerformanceConfidence({ count: 0, accuracy: 0.9, freshness: 1 }), /count/i);
});
