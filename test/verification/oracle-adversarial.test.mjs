import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOracle } from '../../master_brain/verification/harness/oracle.mjs';

const spec = { expected_status: 'AUTHORIZED' };

test('fails when observed status disagrees with reference even if specification looks satisfied', () => {
  const result = evaluateOracle({ specification: spec, reference_state: { status: 'DENIED' }, observed: { status: 'AUTHORIZED' }, invariants: [] });
  assert.equal(result.status, 'FAIL');
});

test('returns INCONCLUSIVE when evidence is unknown rather than upgrading it', () => {
  const result = evaluateOracle({ specification: spec, reference_state: { status: 'AUTHORIZED' }, observed: { status: 'UNKNOWN' }, invariants: [] });
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.match(result.reason, /insufficient|unknown/i);
});

test('returns INCONCLUSIVE for conflicted evidence rather than choosing a winner', () => {
  const result = evaluateOracle({ specification: spec, reference_state: { status: 'CONFLICTED' }, observed: { status: 'CONFLICTED' }, invariants: [] });
  assert.equal(result.status, 'INCONCLUSIVE');
});

test('does not accept an observed authorized state when the reference says denied', () => {
  const result = evaluateOracle({ specification: spec, reference_state: { status: 'DENIED' }, observed: { status: 'AUTHORIZED' }, invariants: [] });
  assert.notEqual(result.status, 'PASS');
});

test('known-good control passes and known-bad control fails', () => {
  const good = evaluateOracle({ specification: spec, reference_state: { status: 'AUTHORIZED' }, observed: { status: 'AUTHORIZED' }, invariants: [] });
  const bad = evaluateOracle({ specification: spec, reference_state: { status: 'AUTHORIZED' }, observed: { status: 'EXECUTED_WITHOUT_AUTHORITY' }, invariants: [{ id: 'I70', status: 'VIOLATED' }] });
  assert.equal(good.status, 'PASS');
  assert.equal(bad.status, 'FAIL');
});
