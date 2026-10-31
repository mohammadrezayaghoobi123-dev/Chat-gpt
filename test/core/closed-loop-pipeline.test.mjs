import test from 'node:test';
import assert from 'node:assert/strict';
import { runClosedLoop } from '../../master_brain/core/closed-loop-pipeline.mjs';

test('records a decision and learns from a verified outcome without bypassing permission', async () => {
  const result = await runClosedLoop({
    decision_id: 'D-100',
    task: { objective: 'select model', risk: 'low', required_capabilities: ['reasoning'] },
    registry: [{ id: 'model-a', capabilities: ['reasoning'], risk_levels: ['low'], reliability: 0.9, cost: 1 }],
    analysis: { verification: { status: 'VERIFIED' }, stability: { status: 'ROBUST' }, value_of_information: { status: 'DECIDE_NOW' }, prediction: { success_probability: 0.9 }, risk: { impact: 'LOW', probability: 0.05, reversibility: 'REVERSIBLE' } },
    executed: true,
    observed: { success: true },
  });
  assert.equal(result.pipeline.status, 'PROCEED');
  assert.equal(result.ledger.length, 1);
  assert.equal(result.outcome.status, 'MATCHED');
  assert.equal(result.learning.models['model-a'].capabilities.reasoning.count, 1);
});

test('does not learn from an authorized decision until it is actually executed', async () => {
  const result = await runClosedLoop({
    decision_id: 'D-102',
    task: { objective: 'prepare action', risk: 'low', required_capabilities: ['reasoning'] },
    registry: [{ id: 'model-a', capabilities: ['reasoning'], risk_levels: ['low'], reliability: 0.9, cost: 1 }],
    analysis: { verification: { status: 'VERIFIED' }, stability: { status: 'ROBUST' }, value_of_information: { status: 'DECIDE_NOW' }, prediction: { success_probability: 0.9 }, risk: { impact: 'LOW', probability: 0.05, reversibility: 'REVERSIBLE' } },
    observed: { success: true },
  });
  assert.equal(result.pipeline.permission.allowed, true);
  assert.equal(result.pipeline.executed, false);
  assert.equal(result.outcome, undefined);
  assert.equal(result.learning, undefined);
});

test('critical decision is blocked and does not create a false execution outcome', async () => {
  const result = await runClosedLoop({
    decision_id: 'D-101',
    task: { objective: 'critical action', risk: 'critical', required_capabilities: ['reasoning'] },
    registry: [{ id: 'model-a', capabilities: ['reasoning'], risk_levels: ['critical'], reliability: 0.99, cost: 1 }],
    analysis: { verification: { status: 'VERIFIED' }, stability: { status: 'ROBUST' }, value_of_information: { status: 'DECIDE_NOW' }, prediction: { success_probability: 0.99 }, risk: { impact: 'CRITICAL', probability: 0.1, reversibility: 'IRREVERSIBLE' } },
    observed: { success: true },
  });
  assert.equal(result.pipeline.status, 'REJECT');
  assert.equal(result.pipeline.executed, false);
  assert.equal(result.outcome, undefined);
  assert.equal(result.ledger.length, 1);
});
