import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTrustArchitecture } from '../../master_brain/verification/harness/trust-architecture-selector.mjs';

test('trust architecture selects cryptographic transparency without forcing blockchain', () => {
  const result = selectTrustArchitecture({
    parties: 1,
    privacy: 'HIGH',
    deletion_required: true,
    independent_audit: true,
    throughput: 'HIGH',
    cross_organization_trust: false,
  });
  assert.equal(result.primary, 'SIGNED_TRANSPARENCY_LOG');
  assert.equal(result.blockchain_required, false);
});

test('multi-organization shared trust can select DLT as an anchor', () => {
  const result = selectTrustArchitecture({
    parties: 4,
    privacy: 'MEDIUM',
    deletion_required: false,
    independent_audit: true,
    throughput: 'MEDIUM',
    cross_organization_trust: true,
  });
  assert.equal(result.blockchain_required, true);
  assert.ok(result.supporting.includes('MERKLE_EVIDENCE'));
});

test('sensitive AI workloads can require confidential computing as a separate layer', () => {
  const result = selectTrustArchitecture({
    parties: 2,
    privacy: 'CRITICAL',
    deletion_required: true,
    independent_audit: true,
    throughput: 'HIGH',
    cross_organization_trust: true,
    sensitive_compute: true,
  });
  assert.ok(result.supporting.includes('CONFIDENTIAL_COMPUTING'));
  assert.ok(result.supporting.includes('THRESHOLD_CRYPTOGRAPHY'));
});

test('unknown requirements fail closed', () => {
  assert.equal(selectTrustArchitecture({ privacy: 'UNKNOWN' }).status, 'INCONCLUSIVE');
});
