import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createThresholdPolicy,
  evaluateThresholdApproval,
} from '../../master_brain/verification/harness/threshold-authorization.mjs';

test('threshold approval requires a real quorum of distinct verified participants', () => {
  const policy = createThresholdPolicy({ threshold: 2, participants: ['a','b','c'] });
  const result = evaluateThresholdApproval({
    policy,
    operation_hash: 'sha256:op1',
    approvals: [
      { participant_id: 'a', status: 'VERIFIED', operation_hash: 'sha256:op1' },
      { participant_id: 'b', status: 'VERIFIED', operation_hash: 'sha256:op1' },
    ],
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.approved_participants.length, 2);
});

test('duplicate participant approvals cannot satisfy threshold', () => {
  const policy = createThresholdPolicy({ threshold: 2, participants: ['a','b','c'] });
  const result = evaluateThresholdApproval({
    policy,
    operation_hash: 'sha256:op1',
    approvals: [
      { participant_id: 'a', status: 'VERIFIED', operation_hash: 'sha256:op1' },
      { participant_id: 'a', status: 'VERIFIED', operation_hash: 'sha256:op1' },
    ],
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.reason, 'DUPLICATE_PARTICIPANT');
});

test('wrong operation binding or revoked participant fails closed', () => {
  const policy = createThresholdPolicy({ threshold: 2, participants: ['a','b','c'] });
  const result = evaluateThresholdApproval({
    policy,
    operation_hash: 'sha256:op1',
    approvals: [
      { participant_id: 'a', status: 'VERIFIED', operation_hash: 'sha256:other' },
      { participant_id: 'b', status: 'REVOKED', operation_hash: 'sha256:op1' },
    ],
  });
  assert.equal(result.status, 'FAIL');
});

test('insufficient verified quorum is INCONCLUSIVE, not implicit authorization', () => {
  const policy = createThresholdPolicy({ threshold: 2, participants: ['a','b','c'] });
  const result = evaluateThresholdApproval({
    policy,
    operation_hash: 'sha256:op1',
    approvals: [
      { participant_id: 'a', status: 'VERIFIED', operation_hash: 'sha256:op1' },
    ],
  });
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.reason, 'INSUFFICIENT_QUORUM');
});

test('invalid threshold policy is rejected before any approval is evaluated', () => {
  assert.throws(
    () => createThresholdPolicy({ threshold: 4, participants: ['a','b','c'] }),
    /INVALID_THRESHOLD_POLICY/
  );
});
