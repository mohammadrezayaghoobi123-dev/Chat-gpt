import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrustAnchor } from '../../master_brain/verification/harness/blockchain-trust-layer.mjs';

test('trust anchor verifies evidence integrity without granting execution authority', () => {
  const result = evaluateTrustAnchor({
    record_hash: 'sha256:abc',
    signed_record: true,
    signer_trust: 'VERIFIED',
    anchor_status: 'CONFIRMED',
    authority_effect: 'NONE',
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.authorizes_execution, false);
});

test('unverified or conflicting anchor evidence is not trusted', () => {
  assert.equal(evaluateTrustAnchor({ record_hash: 'sha256:abc', signed_record: true, signer_trust: 'UNKNOWN', anchor_status: 'CONFIRMED', authority_effect: 'NONE' }).status, 'INCONCLUSIVE');
  assert.equal(evaluateTrustAnchor({ record_hash: 'sha256:abc', signed_record: true, signer_trust: 'VERIFIED', anchor_status: 'CONFLICTED', authority_effect: 'NONE' }).status, 'INCONCLUSIVE');
});

test('blockchain anchor cannot elevate authority', () => {
  const result = evaluateTrustAnchor({
    record_hash: 'sha256:abc',
    signed_record: true,
    signer_trust: 'VERIFIED',
    anchor_status: 'CONFIRMED',
    authority_effect: 'GRANT',
  });
  assert.equal(result.status, 'FAIL');
});

test('hash-only or unsigned anchoring is insufficient for critical evidence', () => {
  assert.equal(evaluateTrustAnchor({ record_hash: 'sha256:abc', signed_record: false, signer_trust: 'VERIFIED', anchor_status: 'CONFIRMED', authority_effect: 'NONE' }).status, 'INCONCLUSIVE');
});
