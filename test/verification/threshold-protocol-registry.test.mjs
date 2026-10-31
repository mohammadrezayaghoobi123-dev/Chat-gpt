import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerThresholdProtocol,
  evaluateThresholdProtocolQualification,
  REQUIRED_EVIDENCE,
} from '../../master_brain/verification/harness/threshold-protocol-registry.mjs';

const base = {
  id: 'FROST-Ed25519',
  version: 'RFC9591',
  primitive: 'Schnorr/Ed25519-compatible threshold signature',
  security_model: 'threshold-signing',
  status: 'CANDIDATE',
  secret_shared: true,
  reconstructible_private_key_in_normal_operation: false,
  evidence: Object.fromEntries(REQUIRED_EVIDENCE.map(k => [k, 'VERIFIED'])),
};

test('candidate protocol cannot become production merely because it is well known', () => {
  const result = evaluateThresholdProtocolQualification(registerThresholdProtocol(base));
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.reason, 'PROTOCOL_NOT_ACTIVE');
});

test('missing secret-sharing evidence blocks true-threshold qualification', () => {
  const p = registerThresholdProtocol({ ...base, secret_shared: false, status: 'ACTIVE' });
  const result = evaluateThresholdProtocolQualification(p);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.reason, 'SECRET_SHARING_NOT_VERIFIED');
});

test('single-key reconstruction in normal operation is not accepted as true threshold', () => {
  const p = registerThresholdProtocol({
    ...base,
    status: 'ACTIVE',
    reconstructible_private_key_in_normal_operation: true,
  });
  const result = evaluateThresholdProtocolQualification(p);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.reason, 'SINGLE_KEY_RECONSTRUCTION_NOT_EXCLUDED');
});

test('incomplete independent evidence blocks promotion', () => {
  const evidence = { ...base.evidence, malicious_participant_tests: 'UNKNOWN' };
  const p = registerThresholdProtocol({ ...base, status: 'ACTIVE', evidence });
  const result = evaluateThresholdProtocolQualification(p);
  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(result.reason, 'QUALIFICATION_EVIDENCE_INCOMPLETE');
});

test('fully evidenced active protocol can pass the qualification gate', () => {
  const p = registerThresholdProtocol({ ...base, status: 'ACTIVE' });
  const result = evaluateThresholdProtocolQualification(p);
  assert.equal(result.status, 'PASS');
  assert.equal(result.protocol_id, 'FROST-Ed25519');
});
