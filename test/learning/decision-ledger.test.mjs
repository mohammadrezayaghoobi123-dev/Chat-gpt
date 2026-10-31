import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionRecord, appendDecision } from '../../master_brain/learning/decision-ledger.mjs';

test('creates a decision record with evidence and outcome fields', () => {
  const record = createDecisionRecord({ decision_id: 'D-1', goal: 'test', decision: 'PROCEED', confidence: 0.8 });
  assert.equal(record.type, 'DecisionRecord');
  assert.equal(record.decision_id, 'D-1');
  assert.deepEqual(record.evidence, []);
  assert.equal(record.outcome, undefined);
});

test('appends a unique decision record without mutating the original ledger', () => {
  const ledger = [];
  const record = createDecisionRecord({ decision_id: 'D-1', goal: 'test', decision: 'HOLD', confidence: 0.4 });
  const next = appendDecision(ledger, record);
  assert.equal(ledger.length, 0);
  assert.equal(next.length, 1);
  assert.throws(() => appendDecision(next, record), /duplicate decision_id/i);
});
