import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyOutcome } from '../../master_brain/learning/outcome-verification.mjs';

test('verifies an outcome by comparing prediction with observed result', () => {
  const result = verifyOutcome({ prediction: { success_probability: 0.8 }, observed: { success: true } });
  assert.equal(result.status, 'MATCHED');
  assert.equal(result.prediction_correct, true);
});

test('flags a failed prediction when the observed outcome contradicts it', () => {
  const result = verifyOutcome({ prediction: { success_probability: 0.8 }, observed: { success: false } });
  assert.equal(result.status, 'MISMATCHED');
  assert.equal(result.prediction_correct, false);
});
