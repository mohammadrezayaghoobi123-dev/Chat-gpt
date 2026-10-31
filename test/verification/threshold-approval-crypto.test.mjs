import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  createThresholdPolicy,
  createSignedApproval,
  evaluateSignedThresholdApproval,
} from '../../master_brain/verification/harness/threshold-authorization.mjs';

test('signed quorum verifies distinct participant signatures bound to one operation', () => {
  const a = generateKeyPairSync('ed25519');
  const b = generateKeyPairSync('ed25519');
  const policy = createThresholdPolicy({
    threshold: 2,
    participants: [
      { id:'a', publicKey:a.publicKey.export({format:'pem',type:'spki'}) },
      { id:'b', publicKey:b.publicKey.export({format:'pem',type:'spki'}) },
      { id:'c', publicKey:'not-used' },
    ],
  });
  const operation_hash = 'sha256:op1';
  const approvals = [
    createSignedApproval({ participant_id:'a', operation_hash, privateKey:a.privateKey }),
    createSignedApproval({ participant_id:'b', operation_hash, privateKey:b.privateKey }),
  ];
  const result = evaluateSignedThresholdApproval({ policy, operation_hash, approvals });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.approved_participants.sort(), ['a','b']);
});

test('tampered approval or wrong operation binding cannot satisfy quorum', () => {
  const a = generateKeyPairSync('ed25519');
  const b = generateKeyPairSync('ed25519');
  const policy = createThresholdPolicy({
    threshold: 2,
    participants: [
      { id:'a', publicKey:a.publicKey.export({format:'pem',type:'spki'}) },
      { id:'b', publicKey:b.publicKey.export({format:'pem',type:'spki'}) },
    ],
  });
  const approvalA = createSignedApproval({ participant_id:'a', operation_hash:'sha256:op1', privateKey:a.privateKey });
  const approvalB = createSignedApproval({ participant_id:'b', operation_hash:'sha256:op1', privateKey:b.privateKey });
  approvalB.operation_hash = 'sha256:other';
  const result = evaluateSignedThresholdApproval({
    policy,
    operation_hash:'sha256:op1',
    approvals:[approvalA, approvalB],
  });
  assert.equal(result.status, 'FAIL');
});

test('missing public-key evidence is INCONCLUSIVE rather than trusted', () => {
  const a = generateKeyPairSync('ed25519');
  const policy = createThresholdPolicy({
    threshold: 1,
    participants: [{ id:'a' }],
  });
  const approval = createSignedApproval({ participant_id:'a', operation_hash:'sha256:op1', privateKey:a.privateKey });
  const result = evaluateSignedThresholdApproval({ policy, operation_hash:'sha256:op1', approvals:[approval] });
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.reason, 'MISSING_PUBLIC_KEY');
});
