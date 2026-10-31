import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMutation, evaluateMutation } from '../../master_brain/verification/harness/mutation-engine.mjs';

test('critical killable mutations must be detected', () => {
  const mutation = { mutation_id: 'M1', severity: 'CRITICAL', location: 'decision', intended_difference: 'allow-unauthorized', killability_basis: 'observable', observability: true, oracle_rule: 'R1' };
  assert.equal(classifyMutation(mutation, { observable_rules: ['R1'] }).killable, true);
  assert.equal(evaluateMutation({ ...mutation, result: 'DETECTED' }).status, 'PASS');
  assert.equal(evaluateMutation({ ...mutation, result: 'SURVIVED' }).status, 'FAIL');
});

test('equivalent mutations require explicit independent review and do not silently enter denominator', () => {
  const mutation = { mutation_id: 'M2', severity: 'CRITICAL', intended_difference: 'none', killability_basis: 'observationally-equivalent', observability: false, oracle_rule: 'R1' };
  const classification = classifyMutation(mutation, { observable_rules: ['R1'] });
  assert.equal(classification.killable, false);
  assert.equal(classification.equivalent, true);
  const result = evaluateMutation({ ...mutation, result: 'EQUIVALENT' });
  assert.equal(result.status, 'EXCLUDED_PENDING_REVIEW');
});