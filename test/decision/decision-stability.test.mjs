import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDecisionStability } from '../../master_brain/decision/decision-stability.mjs';

test('marks a decision robust when plausible outcomes keep the same action', () => {
  const result = analyzeDecisionStability({
    scenarios: [
      { name: 'base', action: 'PROCEED', outcome: 100 },
      { name: 'downside', action: 'PROCEED', outcome: 20 }
    ]
  });
  assert.equal(result.status, 'ROBUST');
  assert.equal(result.action, 'PROCEED');
});

test('marks a decision fragile when plausible scenarios change the action', () => {
  const result = analyzeDecisionStability({
    scenarios: [
      { name: 'base', action: 'PROCEED', outcome: 100 },
      { name: 'downside', action: 'STOP', outcome: -20 }
    ]
  });
  assert.equal(result.status, 'FRAGILE');
});
