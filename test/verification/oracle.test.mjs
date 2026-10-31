import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOracle, assertOracleIndependence } from '../../master_brain/verification/harness/oracle.mjs';

test('returns PASS when the observed result satisfies the reference property', () => {
  const result = evaluateOracle({
    specification: { expected_status: 'AUTHORIZED' },
    reference_state: { status: 'AUTHORIZED' },
    observed: { status: 'AUTHORIZED' },
    invariants: []
  });
  assert.equal(result.status, 'PASS');
});

test('returns FAIL when observed behavior violates the specified property', () => {
  const result = evaluateOracle({
    specification: { expected_status: 'AUTHORIZED' },
    reference_state: { status: 'AUTHORIZED' },
    observed: { status: 'EXECUTED_WITHOUT_AUTHORITY' },
    invariants: []
  });
  assert.equal(result.status, 'FAIL');
});

test('returns INCONCLUSIVE with an explicit reason when evidence is insufficient', () => {
  const result = evaluateOracle({ specification: {}, reference_state: {}, observed: {}, invariants: [] });
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.ok(result.reason);
});

test('keeps a safety violation as FAIL even when fault activation is inconclusive', () => {
  const result = evaluateOracle({
    specification: { expected_status: 'AUTHORIZED' },
    reference_state: { status: 'AUTHORIZED' },
    observed: { status: 'EXECUTED_WITHOUT_AUTHORITY' },
    invariants: [{ id: 'I70', status: 'VIOLATED' }],
    fault_activation: 'INCONCLUSIVE'
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.fault_detection, 'INCONCLUSIVE');
});

test('rejects oracle configuration that imports SUT decision logic', () => {
  assert.throws(() => assertOracleIndependence({ dependencies: ['../../master_brain/decision/decision-engine.mjs'] }), /independent/);
});
