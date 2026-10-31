import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTrustArchitecture } from '../../master_brain/verification/harness/trust-architecture-selector.mjs';

test('critical authorization requires hardware-backed key protection and multi-party control', () => {
  const result = selectTrustArchitecture({
    parties: 1,
    privacy: 'CRITICAL',
    deletion_required: true,
    independent_audit: true,
    throughput: 'MEDIUM',
    cross_organization_trust: false,
    sensitive_compute: false,
    critical_authorization: true,
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.supporting.includes('HARDWARE_BACKED_KEY_PROTECTION'));
  assert.ok(result.supporting.includes('THRESHOLD_CRYPTOGRAPHY'));
});

test('privacy-sensitive proof requirements can select zero-knowledge without public blockchain', () => {
  const result = selectTrustArchitecture({
    parties: 2,
    privacy: 'CRITICAL',
    deletion_required: true,
    independent_audit: true,
    throughput: 'HIGH',
    cross_organization_trust: false,
    sensitive_compute: false,
    privacy_proof_required: true,
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.supporting.includes('ZERO_KNOWLEDGE_PROOF'));
  assert.equal(result.blockchain_required, false);
});

test('agent identity requirements add verifiable credentials and independent attestation', () => {
  const result = selectTrustArchitecture({
    parties: 2,
    privacy: 'HIGH',
    deletion_required: false,
    independent_audit: true,
    throughput: 'MEDIUM',
    cross_organization_trust: true,
    agent_identity_required: true,
    execution_attestation_required: true,
  });
  assert.equal(result.status, 'PASS');
  assert.ok(result.supporting.includes('VERIFIABLE_CREDENTIALS'));
  assert.ok(result.supporting.includes('INDEPENDENT_ATTESTATION'));
});

test('requirements that cannot safely select a trust architecture remain inconclusive', () => {
  const result = selectTrustArchitecture({
    parties: 2,
    privacy: 'HIGH',
    deletion_required: undefined,
    throughput: 'MEDIUM',
    cross_organization_trust: true,
  });
  assert.equal(result.status, 'INCONCLUSIVE');
});
