import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCoverage } from '../../master_brain/verification/harness/coverage-analyzer.mjs';

test('freezes coverage denominators and reports separate dimensions', () => {
  const campaign = { manifest: { coverage: { fault: { denominator: 2 }, state: { denominator: 2 } } } };
  const results = [
    { fault_id: 'F01', fault_detection: 'PASS', state: 'S1' },
    { fault_id: 'F02', fault_detection: 'INCONCLUSIVE', state: 'S2' }
  ];
  const first = analyzeCoverage(campaign, results);
  assert.deepEqual(first.fault, { numerator: 1, denominator: 2, rate: 0.5 });
  assert.equal(first.state.denominator, 2);
  assert.equal(first.critical_inconclusive, 1);
  assert.equal(Object.isFrozen(first.denominators), true);
});

test('blocked or unobservable critical items cannot be silently excluded', () => {
  const campaign = { manifest: { coverage: { fault: { denominator: 1, critical_ids: ['F30'] } } } };
  const results = [{ fault_id: 'F30', fault_detection: 'INCONCLUSIVE', exclusion: 'unobservable' }];
  const coverage = analyzeCoverage(campaign, results);
  assert.equal(coverage.fault.rate, 0);
  assert.deepEqual(coverage.blocked, ['F30']);
});