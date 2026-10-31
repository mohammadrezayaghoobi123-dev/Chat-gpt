import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signTrustRecord, verifyTrustRecordAgainstKey } from '../../master_brain/verification/harness/crypto-trust-implementation.mjs';

test('verified key rotation preserves verification while retired key fails', () => {
  const oldKeys = generateKeyPairSync('ed25519');
  const newKeys = generateKeyPairSync('ed25519');
  const signed = signTrustRecord({ key_epoch: 2, action: 'ANCHOR' }, newKeys.privateKey);
  assert.equal(verifyTrustRecordAgainstKey(signed, { status: 'VERIFIED', publicKey: newKeys.publicKey }).status, 'PASS');
  assert.equal(verifyTrustRecordAgainstKey(signed, { status: 'REVOKED', publicKey: oldKeys.publicKey }).status, 'FAIL');
});

test('missing key lifecycle state does not become trusted by default', () => {
  const keys = generateKeyPairSync('ed25519');
  const signed = signTrustRecord({ action: 'ANCHOR' }, keys.privateKey);
  assert.equal(verifyTrustRecordAgainstKey(signed, { publicKey: keys.publicKey }).status, 'INCONCLUSIVE');
});
