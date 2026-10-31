import test from 'node:test';
import assert from 'node:assert/strict';
import { appendVerificationRecord, freezeLedgerRevision, createVerificationLedger } from '../../master_brain/verification/harness/verification-ledger.mjs';

test('ledger records complete traceability and remains append-only', () => {
  const ledger = createVerificationLedger();
  const record = appendVerificationRecord(ledger, {
    verification_id: 'V1', run_id: 'R1', scenario_id: 'S1',
    requirement_ids: ['REQ-1'], invariant_ids: ['I76'], fault_id: 'F01',
    SUT_version: 'sut-1', harness_version: 'h-1', specification_version: 'spec-1',
    policy_version: 'p-1', reference_model_version: 'rm-1', environment_id: 'env-1',
    expected_result: 'PASS', observed_result: 'PASS', evidence_refs: ['E1'],
    oracle_result: 'PASS', coverage_snapshot: { fault: { numerator: 1, denominator: 1 } },
    timestamp: '2026-10-05T12:00:00Z', verifier: 'oracle', status: 'PASSED'
  });
  assert.equal(record.verification_id, 'V1');
  const frozen = freezeLedgerRevision(ledger, 'R1');
  assert.equal(frozen.records.length, 1);
  assert.equal(Object.isFrozen(frozen.records), true);
  assert.throws(() => frozen.records.push(record), TypeError);
  assert.equal(ledger.records.length, 1);
});

test('ledger rejects critical records missing traceability or version metadata', () => {
  const ledger = createVerificationLedger();
  assert.throws(() => appendVerificationRecord(ledger, { verification_id: 'V2', status: 'PASSED' }), /traceability|version/i);
});