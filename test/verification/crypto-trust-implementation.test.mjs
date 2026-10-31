import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  canonicalizeRecord,
  signTrustRecord,
  verifyTrustRecord,
  verifyTrustRecordAgainstKey,
} from '../../master_brain/verification/harness/crypto-trust-implementation.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

test('real Ed25519 signature verifies a canonical trust record', () => {
  const record = { z: 2, a: 'alpha', nested: { b: true, a: 1 } };
  const signed = signTrustRecord(record, privateKey);
  assert.equal(verifyTrustRecord(signed, publicKey).status, 'PASS');
  assert.equal(canonicalizeRecord(record), canonicalizeRecord({ nested: { a: 1, b: true }, a: 'alpha', z: 2 }));
});

test('tampering after signing is detected', () => {
  const signed = signTrustRecord({ action: 'ANCHOR', value: 7 }, privateKey);
  const tampered = { ...signed, record: { action: 'ANCHOR', value: 8 } };
  assert.equal(verifyTrustRecord(tampered, publicKey).status, 'FAIL');
});

test('wrong key does not verify', () => {
  const { publicKey: otherKey } = generateKeyPairSync('ed25519');
  const signed = signTrustRecord({ action: 'ANCHOR' }, privateKey);
  assert.equal(verifyTrustRecord(signed, otherKey).status, 'FAIL');
});

test('revoked or unknown key evidence fails closed', () => {
  const signed = signTrustRecord({ action: 'ANCHOR' }, privateKey);
  assert.equal(verifyTrustRecordAgainstKey(signed, { status: 'REVOKED', publicKey }).status, 'FAIL');
  assert.equal(verifyTrustRecordAgainstKey(signed, { status: 'UNKNOWN', publicKey }).status, 'INCONCLUSIVE');
});
