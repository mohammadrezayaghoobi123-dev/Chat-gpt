import test from 'node:test';
import assert from 'node:assert/strict';
import { assessValueOfInformation } from '../../master_brain/decision/value-of-information.mjs';

test('recommends collecting information when expected decision improvement exceeds its cost', () => {
  const result = assessValueOfInformation({
    current_value: 100,
    expected_value_with_information: 130,
    information_cost: 10
  });
  assert.equal(result.status, 'COLLECT_INFORMATION');
  assert.equal(result.net_value, 20);
});

test('recommends deciding now when information is not worth its cost', () => {
  const result = assessValueOfInformation({
    current_value: 100,
    expected_value_with_information: 105,
    information_cost: 10
  });
  assert.equal(result.status, 'DECIDE_NOW');
  assert.equal(result.net_value, -5);
});
