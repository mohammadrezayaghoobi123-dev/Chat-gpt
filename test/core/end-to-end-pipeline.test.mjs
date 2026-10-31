import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionPipeline } from '../../master_brain/core/end-to-end-pipeline.mjs';

test('runs a verified low-risk decision through routing and permission without executing an external action', async () => {
  const result = await runDecisionPipeline({ task: { objective: 'choose model', risk: 'low', required_capabilities: ['reasoning'] }, registry: [{ id: 'model-a', capabilities: ['reasoning'], risk_levels: ['low'], reliability: 0.9, cost: 1 }], learning: {}, analysis: { verification: { status: 'VERIFIED' }, stability: { status: 'ROBUST' }, value_of_information: { status: 'DECIDE_NOW' }, prediction: { success_probability: 0.9 }, risk: { impact: 'LOW', probability: 0.05, reversibility: 'REVERSIBLE' } } });
  assert.equal(result.status, 'PROCEED');
  assert.equal(result.permission.allowed, true);
  assert.equal(result.route[0].id, 'model-a');
  assert.equal(result.executed, false);
});

test('blocks a critical decision before execution even with favorable prediction', async () => {
  const result = await runDecisionPipeline({ task: { objective: 'critical action', risk: 'critical', required_capabilities: ['reasoning'] }, registry: [{ id: 'model-a', capabilities: ['reasoning'], risk_levels: ['critical'], reliability: 0.99, cost: 1 }], analysis: { verification: { status: 'VERIFIED' }, stability: { status: 'ROBUST' }, value_of_information: { status: 'DECIDE_NOW' }, prediction: { success_probability: 0.99 }, risk: { impact: 'CRITICAL', probability: 0.1, reversibility: 'IRREVERSIBLE' } } });
  assert.equal(result.status, 'REJECT');
  assert.equal(result.permission.allowed, false);
  assert.equal(result.permission.requires_approval, true);
  assert.equal(result.executed, false);
});
