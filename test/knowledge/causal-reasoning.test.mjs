import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCausalClaim } from '../../master_brain/knowledge/causal-reasoning.mjs';

test('supports a causal claim when mechanism, evidence, alternatives and counterfactual are addressed', () => {
  const result = assessCausalClaim({
    cause: 'A', effect: 'B', mechanism: 'A changes the process that produces B',
    evidence: ['controlled experiment'], alternative_explanations: [], counterfactual: 'Without A, B does not occur'
  });
  assert.equal(result.status, 'CAUSAL_SUPPORTED');
});

test('does not upgrade correlation to causation', () => {
  const result = assessCausalClaim({ cause: 'A', effect: 'B', evidence: ['correlation'] });
  assert.equal(result.status, 'CORRELATIONAL_ONLY');
});
