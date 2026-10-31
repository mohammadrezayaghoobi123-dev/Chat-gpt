import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  createKeyRegistry, registerKey, rotateKey, revokeKey, resolveKey, canAuthorizeRotation,
} from '../../master_brain/verification/harness/crypto-key-registry.mjs';

test('key registry enforces explicit lifecycle and rotation', () => {
  const keys = generateKeyPairSync('ed25519');
  const registry = createKeyRegistry();
  const added = registerKey(registry, { key_id:'k1', algorithm:'Ed25519', publicKey:keys.publicKey.export({format:'pem',type:'spki'}), status:'ACTIVE', epoch:1 });
  assert.equal(added.status, 'PASS');
  assert.equal(resolveKey(registry,'k1').status, 'ACTIVE');
  assert.equal(rotateKey(registry,'k1',{key_id:'k2',algorithm:'Ed25519',publicKey:'new-key',epoch:2},{approvals:1,required_approvals:2}).status,'FAIL');
  const rotated = rotateKey(registry,'k1',{key_id:'k2',algorithm:'Ed25519',publicKey:'new-key',epoch:2},{approvals:2,required_approvals:2,distinct_approvers:true});
  assert.equal(rotated.status, 'PASS');
  assert.equal(resolveKey(registry,'k1').status, 'RETIRED');
  assert.equal(resolveKey(registry,'k2').status, 'ACTIVE');
});

test('revocation is monotonic and blocks future trust', () => {
  const registry = createKeyRegistry();
  registerKey(registry,{key_id:'k1',algorithm:'Ed25519',publicKey:'pk',status:'ACTIVE',epoch:1});
  assert.equal(revokeKey(registry,'k1').status,'PASS');
  assert.equal(resolveKey(registry,'k1').status,'REVOKED');
  assert.equal(revokeKey(registry,'k1').status,'FAIL');
});

test('crypto-agility rejects unsupported algorithms and accepts registered ones', () => {
  const registry = createKeyRegistry({algorithms:['Ed25519','ML-DSA-65']});
  assert.equal(registerKey(registry,{key_id:'x',algorithm:'UNKNOWN',publicKey:'pk',status:'ACTIVE',epoch:1}).status,'FAIL');
  assert.equal(registerKey(registry,{key_id:'y',algorithm:'ML-DSA-65',publicKey:'pk',status:'ACTIVE',epoch:1}).status,'PASS');
});

test('critical rotation requires independent approval threshold', () => {
  assert.equal(canAuthorizeRotation({approvals:2,required_approvals:2,distinct_approvers:true}).status,'PASS');
  assert.equal(canAuthorizeRotation({approvals:2,required_approvals:2,distinct_approvers:false}).status,'FAIL');
});
