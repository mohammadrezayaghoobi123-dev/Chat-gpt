import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTrustArchitecture } from '../../master_brain/verification/harness/trust-architecture-selector.mjs';
import { evaluateTrustAnchor } from '../../master_brain/verification/harness/blockchain-trust-layer.mjs';

test('DLT selection never implies authorization', () => {
  const a = selectTrustArchitecture({
    parties: 3, privacy: 'MEDIUM', deletion_required: false,
    throughput: 'MEDIUM', cross_organization_trust: true,
  });
  assert.equal(a.blockchain_required, true);
  const anchor = evaluateTrustAnchor({
    record_hash: 'sha256:x', signed_record: true, signer_trust: 'VERIFIED',
    anchor_status: 'CONFIRMED', authority_effect: 'NONE',
  });
  assert.equal(anchor.authorizes_execution, false);
});

test('critical authorization cannot silently fall back to a single key', () => {
  const a = selectTrustArchitecture({
    parties: 1, privacy: 'HIGH', deletion_required: true,
    throughput: 'HIGH', cross_organization_trust: false,
    critical_authorization: true,
  });
  assert.equal(a.status, 'PASS');
  assert.ok(a.supporting.includes('HARDWARE_BACKED_KEY_PROTECTION'));
  assert.ok(a.supporting.includes('THRESHOLD_CRYPTOGRAPHY'));
});

test('privacy proof remains independent of blockchain choice', () => {
  const a = selectTrustArchitecture({
    parties: 1, privacy: 'CRITICAL', deletion_required: true,
    throughput: 'HIGH', cross_organization_trust: false,
    privacy_proof_required: true,
  });
  assert.equal(a.blockchain_required, false);
  assert.ok(a.supporting.includes('ZERO_KNOWLEDGE_PROOF'));
});

test('incomplete critical requirements remain inconclusive', () => {
  const a = selectTrustArchitecture({
    parties: 2, privacy: 'HIGH', throughput: 'MEDIUM',
    cross_organization_trust: true,
  });
  assert.equal(a.status, 'INCONCLUSIVE');
});

test('conflicting or unverified anchors fail closed', () => {
  assert.equal(evaluateTrustAnchor({
    record_hash: 'sha256:x', signed_record: true,
    signer_trust: 'VERIFIED', anchor_status: 'CONFLICTED',
    authority_effect: 'NONE',
  }).status, 'INCONCLUSIVE');

  assert.equal(evaluateTrustAnchor({
    record_hash: 'sha256:x', signed_record: true,
    signer_trust: 'UNKNOWN', anchor_status: 'CONFIRMED',
    authority_effect: 'NONE',
  }).status, 'INCONCLUSIVE');
});
