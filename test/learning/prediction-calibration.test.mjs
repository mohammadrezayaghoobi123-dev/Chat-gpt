import test from 'node:test';
import assert from 'node:assert/strict';
import { calibratePredictions } from '../../master_brain/learning/prediction-calibration.mjs';

test('calculates observed success rate for comparable predictions', () => {
  const result = calibratePredictions([
    { predicted_probability: 0.8, observed_success: true },
    { predicted_probability: 0.8, observed_success: false },
    { predicted_probability: 0.8, observed_success: true },
    { predicted_probability: 0.8, observed_success: true },
  ]);
  assert.equal(result.count, 4);
  assert.equal(result.observed_rate, 0.75);
  assert.equal(result.predicted_rate, 0.8);
  assert.equal(result.calibration_error, 0.05);
});

test('rejects an empty calibration sample', () => {
  assert.throws(() => calibratePredictions([]), /samples are required/i);
});
