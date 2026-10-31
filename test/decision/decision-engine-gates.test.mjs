import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../master_brain/decision/decision-engine.mjs';

const base = {
  prediction: { success_probability: 0.8 },
  risk: { impact: 'LOW', probability: 0.1, reversibility: 'REVERSIBLE' },
  verification: { status: 'VERIFIED' },
  stability: { status: 'ROBUST' },
  value_of_information: { status: 'DECIDE_NOW' }
};

test('holds when verification is incomplete', () => {
  assert.equal(decide({ ...base, verification: { status: 'BLOCKED' } }).status, 'HOLD');
});

test('holds when more information has positive value', () => {
  assert.equal(decide({ ...base, value_of_information: { status: 'COLLECT_INFORMATION' } }).status, 'HOLD');
});
