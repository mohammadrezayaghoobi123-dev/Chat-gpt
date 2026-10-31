import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../master_brain/decision/decision-engine.mjs';

test('rejects a high-downside decision even when prediction is favorable', () => {
  const result = decide({
    prediction: { success_probability: 0.7 },
    risk: { impact: 'CRITICAL', probability: 0.3, reversibility: 'IRREVERSIBLE' },
    verification: { status: 'VERIFIED' },
    stability: { status: 'ROBUST' },
    value_of_information: { status: 'DECIDE_NOW' }
  });
  assert.equal(result.status, 'REJECT');
});

test('recommends proceeding when verified, stable and low risk', () => {
  const result = decide({
    prediction: { success_probability: 0.8 },
    risk: { impact: 'LOW', probability: 0.1, reversibility: 'REVERSIBLE' },
    verification: { status: 'VERIFIED' },
    stability: { status: 'ROBUST' },
    value_of_information: { status: 'DECIDE_NOW' }
  });
  assert.equal(result.status, 'PROCEED');
});
