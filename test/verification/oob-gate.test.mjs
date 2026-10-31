import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOutOfBandEnforcement, evaluateJitCredential, RESULT } from '../../master_brain/verification/harness/out-of-band-enforcement.mjs';

test('protected effect requires independent out-of-band enforcement', () => {
  const result = evaluateOutOfBandEnforcement({
    request: { effect:'IRREVERSIBLE_WRITE', target:'sandbox-target', request_hash:'r1', intent_hash:'i1' },
    runtime: { enforcement_plane:'OUT_OF_BAND', policy_source:'INDEPENDENT_POLICY_ENGINE', sandbox_status:'ISOLATED', effect_observed:true, request_hash:'r1', intent_hash:'i1', quarantine_capable:true },
    policy: { decision:'ALLOW' }
  });
  assert.equal(result.status, RESULT.PASS);
});

test('in-band model policy cannot authorize protected effect', () => {
  const result = evaluateOutOfBandEnforcement({
    request: { effect:'IRREVERSIBLE_WRITE', target:'sandbox-target', request_hash:'r1', intent_hash:'i1' },
    runtime: { enforcement_plane:'IN_BAND', policy_source:'MODEL', sandbox_status:'ISOLATED', effect_observed:true, request_hash:'r1', intent_hash:'i1', quarantine_capable:true },
    policy: { decision:'ALLOW' }
  });
  assert.equal(result.status, RESULT.FAIL);
});

test('JIT credential requires bounded scope, valid lifetime and sender binding', () => {
  const result = evaluateJitCredential({
    credential: { status:'ACTIVE', provenance:'VERIFIED', scope:['task:run'], audience:'runtime', issued_at:'VALID', expires_at:'VALID', sender_binding:'VERIFIED' },
    request: { audience:'runtime', scope:'task:run', consequential:true }
  });
  assert.equal(result.status, RESULT.PASS);
});

test('wildcard JIT scope is rejected', () => {
  const result = evaluateJitCredential({
    credential: { status:'ACTIVE', provenance:'VERIFIED', scope:['*'], audience:'runtime', issued_at:'VALID', expires_at:'VALID', sender_binding:'VERIFIED' },
    request: { audience:'runtime', scope:'task:run', consequential:true }
  });
  assert.equal(result.status, RESULT.FAIL);
});
