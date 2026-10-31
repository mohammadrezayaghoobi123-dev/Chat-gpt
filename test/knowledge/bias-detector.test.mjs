import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBiases } from '../../master_brain/knowledge/bias-detector.mjs';

test('detects explicitly signaled biases and returns severity without inventing unlisted biases', () => {
  const result = detectBiases({
    indicators: {
      confirmation: true,
      anchoring: false,
      authority: true,
    },
    severity: { confirmation: 'HIGH' }
  });
  assert.deepEqual(result.detected, [
    { bias: 'CONFIRMATION_BIAS', severity: 'HIGH' },
    { bias: 'AUTHORITY_BIAS', severity: 'MEDIUM' },
  ]);
});

test('returns a clean result when no bias indicators are present', () => {
  assert.deepEqual(detectBiases({ indicators: {} }).detected, []);
});
