import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCalculation } from '../../master_brain/knowledge/quantitative-validation.mjs';

test('validates a calculation with consistent units and detects the expected result', () => {
  const result = validateCalculation({
    inputs: [{ name: 'mass', value: 100, unit: 'kg' }, { name: 'price', value: 2, unit: 'USD/kg' }],
    operation: 'multiply', expected: { value: 200, unit: 'USD' }
  });
  assert.equal(result.status, 'VALID');
  assert.equal(result.value, 200);
  assert.equal(result.unit, 'USD');
});

test('rejects a dimensionally inconsistent calculation', () => {
  const result = validateCalculation({
    inputs: [{ name: 'mass', value: 100, unit: 'kg' }, { name: 'price', value: 2, unit: 'USD' }],
    operation: 'multiply', expected: { value: 200, unit: 'USD' }
  });
  assert.equal(result.status, 'INVALID_UNITS');
});
