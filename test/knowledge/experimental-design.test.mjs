import test from 'node:test';
import assert from 'node:assert/strict';
import { designExperiment } from '../../master_brain/knowledge/experimental-design.mjs';

test('builds an experiment with variables, control and measurements', () => {
  const result = designExperiment({
    question: 'Does A improve B?',
    hypothesis: 'A increases B',
    independent_variables: ['A'],
    dependent_variables: ['B'],
    controls: ['baseline'],
    measurements: ['B'],
    falsification_criteria: ['B does not increase']
  });
  assert.equal(result.status, 'DESIGN_READY');
  assert.deepEqual(result.independent_variables, ['A']);
});

test('does not mark an experiment ready without a control', () => {
  const result = designExperiment({ question: 'Q', hypothesis: 'H', independent_variables: ['A'], dependent_variables: ['B'] });
  assert.equal(result.status, 'INCOMPLETE');
});