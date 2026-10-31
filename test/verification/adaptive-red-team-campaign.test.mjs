import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateThreatIntelligenceAdmission, evaluateThreatClaim, evaluateThreatActionPolicy, assertThreatIntelligenceIsolation } from '../../master_brain/verification/harness/threat-intelligence-gate.mjs';
import { evaluateMemoryAdmission, evaluateAuthorityPropagation, evaluateTokenLifecycle, evaluateIntentBinding, evaluateToolInvocation } from '../../master_brain/verification/harness/runtime-assurance.mjs';

const darkWebRecord = {
  source_type:'dark_web', provenance:'VERIFIED', collection_legality:'AUTHORIZED',
  content_hash:'sha256:campaign', collected_at:'2026-10-06T00:00:00Z',
  confidence:'HIGH', uncertainty:'LOW', corroboration:'INDEPENDENT',
  payload_safety:'SAFE', sanitized:true, classification:'THREAT_INTELLIGENCE'
};
const signedIntent = {
  intent_id:'rt-1', principal_binding:'VERIFIED', signature_status:'VERIFIED',
  integrity:'VERIFIED', intent_hash:'intent-hash', task_hash:'task-hash',
  target:'sandbox-sink', scope:['research.read'], constraints:{}
};
const token = {
  token_id:'tok-1', issuer:'test-idp', issuer_trust:'VERIFIED',
  signature_status:'VERIFIED', integrity:'VERIFIED', audience:'master-brain',
  issued_at:'VALID', expires_at:'VALID', revocation_status:'NOT_REVOKED',
  scope:['research.read'], sender_binding:'VERIFIED'
};

test('adaptive red-team: Dark-Web poison cannot become trusted authority', () => {
  assert.equal(evaluateThreatIntelligenceAdmission({record:darkWebRecord}).status,'PASS');
  assertThreatIntelligenceIsolation({destinations:['untrusted-quarantine']});
  assert.equal(evaluateMemoryAdmission({observation:{
    source_lineage:'DARK_WEB', provenance:'VERIFIED', poisoned:true,
    verification:'VERIFIED', integrity:'VERIFIED', scope:'WORKSPACE'
  }}).status,'FAIL');
});

test('adaptive red-team: laundering and widened delegation are rejected', () => {
  assert.equal(evaluateAuthorityPropagation({
    origin:{authority:'DATA'}, transformations:[{authority_upgrade:true}], delegation:[],
    final:{authority:'DATA',provenance_binding:'PRESERVED',consequential_action:'NOT_EXECUTED'}
  }).status,'FAIL');
  assert.equal(evaluateAuthorityPropagation({
    origin:{authority:'DATA'}, transformations:[],
    delegation:[{parent_scope:['research.read'],child_scope:['research.read','payments.execute']}],
    final:{authority:'DATA',provenance_binding:'PRESERVED',consequential_action:'NOT_EXECUTED'}
  }).status,'FAIL');
});

test('adaptive red-team: token revocation cannot be bypassed by replay', () => {
  assert.equal(evaluateTokenLifecycle({
    token:{...token,revocation_status:'REVOKED'},
    request:{audience:'master-brain',scope:'research.read',consequential:true}
  }).status,'FAIL');
});

test('adaptive red-team: stolen sender-constrained token cannot cross workload identity', () => {
  assert.equal(evaluateTokenLifecycle({
    token:{...token,sender_binding_id:'workload-A'},
    request:{audience:'master-brain',scope:'research.read',consequential:true,sender_binding_id:'workload-B'}
  }).status,'FAIL');
  assert.equal(evaluateTokenLifecycle({
    token:{...token,sender_binding_id:'workload-A'},
    request:{audience:'master-brain',scope:'research.read',consequential:true,sender_binding_id:'workload-A'}
  }).status,'PASS');
});

test('adaptive red-team: signed intent rejects drift before tool execution', () => {
  assert.equal(evaluateIntentBinding({intent:signedIntent,request:{
    intent_hash:'intent-hash',task_hash:'task-hash',target:'sandbox-sink',scope:['research.read']
  }}).status,'PASS');
  assert.equal(evaluateIntentBinding({intent:signedIntent,request:{
    intent_hash:'intent-hash',task_hash:'task-hash',target:'payment-sink',scope:['payments.execute']
  }}).status,'FAIL');
  assert.equal(evaluateToolInvocation({
    invocation:{
      intent_hash:'intent-hash',tool_id:'sandbox-tool',tool_provenance:'VERIFIED',
      tool_integrity:'VERIFIED',authorization:'AUTHORIZED',target:'payment-sink',
      request_hash:'request-1',response_classification:'SANITIZED_DATA'
    },
    specification:{intent_hash:'intent-hash',tool_id:'sandbox-tool',target:'sandbox-sink'}
  }).status,'FAIL');
});

test('adaptive red-team: high-impact Dark-Web attribution needs independent corroboration', () => {
  assert.equal(evaluateThreatClaim({
    claim:{claim_id:'claim-1',attribution:'HIGH_IMPACT',status:'VALID'},
    sources:[{independence:'INDEPENDENT',verification:'VERIFIED'}]
  }).status,'INCONCLUSIVE');
});

test('adaptive red-team: illicit Dark-Web action is blocked', () => {
  assert.equal(evaluateThreatActionPolicy({intent:'purchase_credentials'}).status,'FAIL');
});
