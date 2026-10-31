import test from 'node:test';
import assert from 'node:assert/strict';
import { updateLearningMemory } from '../../master_brain/learning/learning-memory.mjs';

test('records model performance by capability without losing prior observations', () => {
  const memory = updateLearningMemory({}, { model_id: 'model-a', capability: 'reasoning', prediction_correct: true });
  const next = updateLearningMemory(memory, { model_id: 'model-a', capability: 'reasoning', prediction_correct: false });
  assert.equal(next.models['model-a'].capabilities.reasoning.count, 2);
  assert.equal(next.models['model-a'].capabilities.reasoning.accuracy, 0.5);
});

test('rejects incomplete learning observations', () => {
  assert.throws(() => updateLearningMemory({}, { model_id: 'model-a' }), /capability/i);
});
