import assert from 'node:assert/strict';
import test from 'node:test';
import { auditAssumptions } from '../../master_brain/knowledge/assumption-auditor.mjs';

test('audits assumptions and preserves their evidence status and decision impact', () => {
  const result = auditAssumptions([
    { name: 'raw material price', status: 'ESTIMATED', impact: 'HIGH' },
    { name: 'machine capacity', status: 'MEASURED', impact: 'MEDIUM' },
  ]);

  assert.equal(result.total, 2);
  assert.equal(result.by_status.ESTIMATED, 1);
  assert.equal(result.by_status.MEASURED, 1);
  assert.equal(result.high_impact_unverified.length, 1);
  assert.equal(result.high_impact_unverified[0].name, 'raw material price');
});

test('rejects unknown assumption statuses', () => {
  assert.throws(
    () => auditAssumptions([{ name: 'x', status: 'MAYBE', impact: 'LOW' }]),
    /invalid assumption status/i,
  );
});
