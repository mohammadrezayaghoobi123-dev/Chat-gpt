import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFalsification } from '../../master_brain/knowledge/falsification-engine.mjs';

test('defines a falsification criterion for a testable hypothesis', () => {
  const result = assessFalsification({
    hypothesis: 'A improves B',
    prediction: 'B increases when A is applied',
    test: 'controlled experiment',
    falsification_criteria: ['B does not increase']
  });
  assert.equal(result.status, 'TESTABLE');
  assert.equal(result.falsification_criteria.length, 1);
});

test('marks a hypothesis incomplete when falsification criteria are missing', () => {
  const result = assessFalsification({ hypothesis: 'A improves B', prediction: 'B increases' });
  assert.equal(result.status, 'INCOMPLETE');
});