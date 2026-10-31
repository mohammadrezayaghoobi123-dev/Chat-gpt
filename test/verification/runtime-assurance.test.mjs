import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExecutionProcess, evaluateCapabilityAdmission, evaluateMemoryAdmission, evaluateMemoryAuthority, evaluateMemoryRetrieval, evaluateMemoryLifecycle, evaluateAgentIdentityAuthorization, evaluateTokenLifecycle, evaluateAuthorityPropagation, evaluateMultiAgentPropagation, evaluateToolInvocation, evaluateIntentBinding } from '../../master_brain/verification/harness/runtime-assurance.mjs';

const goodTrace = {
  intent_hash: 'i1', authority: 'VALID', policy: 'AVAILABLE', execution_gate: 'OPEN',
  target: 'sink-A', parameters_hash: 'p1', execution: 'EXECUTED',
  audit_integrity: 'VERIFIED', evidence: 'VERIFIED'
};

test('F35 gate bypass is independently detected', () => {
  assert.equal(evaluateExecutionProcess({trace:{...goodTrace, execution_gate:'CLOSED'}, specification:{target:'sink-A'}}).status, 'FAIL');
});
test('F36 audit forgery cannot become PASS without independently verified audit', () => {
  assert.equal(evaluateExecutionProcess({trace:{...goodTrace, audit_integrity:'FORGED'}}).status, 'INCONCLUSIVE');
});
test('F37 silent host failure remains unresolved instead of being upgraded', () => {
  const { audit_integrity, ...trace } = goodTrace;
  assert.equal(evaluateExecutionProcess({trace}).status, 'INCONCLUSIVE');
});
test('F38 wrong target is a hard process failure', () => {
  assert.equal(evaluateExecutionProcess({trace:goodTrace, specification:{target:'sink-B'}}).status, 'FAIL');
});

test('F39 capability poisoning cannot activate an unverified capability', () => {
  assert.equal(evaluateCapabilityAdmission({capability:{status:'QUARANTINED',provenance:'CORRUPTED',integrity:'FAILED',compatibility:'UNKNOWN'}}).status, 'FAIL');
  assert.equal(evaluateCapabilityAdmission({capability:{status:'ACTIVE',provenance:'UNKNOWN',integrity:'VERIFIED',compatibility:'COMPATIBLE'}}).status, 'INCONCLUSIVE');
});

test('F40 memory poisoning cannot enter verified memory', () => {
  assert.equal(evaluateMemoryAdmission({observation:{poisoned:true,provenance:'CORRUPTED',verification:'VERIFIED',source_lineage:'x'}}).status, 'FAIL');
  assert.equal(evaluateMemoryAdmission({observation:{contradiction:true,provenance:'VERIFIED',verification:'VERIFIED',source_lineage:'x'}}).status, 'INCONCLUSIVE');
});

test('F41 specialist failure cannot silently cascade into PROCEED', () => {
  assert.equal(evaluateMultiAgentPropagation({agents:[{status:'FAIL',verification:'VERIFIED'},{status:'PASS',verification:'VERIFIED'}],final:{status:'PROCEED'}}).status, 'FAIL');
});

test('F42 dependency compromise stays non-activatable without verified provenance/integrity', () => {
  assert.equal(evaluateCapabilityAdmission({capability:{status:'ACTIVE',provenance:'VERIFIED',integrity:'FAILED',compatibility:'COMPATIBLE'}}).status, 'INCONCLUSIVE');
});

test('tool invocation provenance and hostile-response gate fail closed', () => {
  const good = {
    intent_hash:'i1', tool_id:'web-search', tool_provenance:'VERIFIED', tool_integrity:'VERIFIED',
    authorization:'AUTHORIZED', target:'internet', request_hash:'r1', response_classification:'SANITIZED_DATA'
  };
  assert.equal(evaluateToolInvocation({invocation:good, specification:{intent_hash:'i1',tool_id:'web-search'}}).status, 'PASS');
  assert.equal(evaluateToolInvocation({invocation:{...good, response_classification:'PROMPT_INJECTION'}}).status, 'FAIL');
  assert.equal(evaluateToolInvocation({invocation:{...good, tool_provenance:'UNKNOWN'}}).status, 'INCONCLUSIVE');
});

test('persistent memory rejects untrusted instructions and expired records', () => {
  const good = {provenance:'VERIFIED',verification:'VERIFIED',source_lineage:'verified-source',content_classification:'FACT',source_trust:'TRUSTED',integrity:'VERIFIED',scope:'WORKSPACE'};
  assert.equal(evaluateMemoryAdmission({observation:good}).status, 'PASS');
  assert.equal(evaluateMemoryAdmission({observation:{...good,content_classification:'INSTRUCTION',source_trust:'UNTRUSTED'}}).status, 'FAIL');
  assert.equal(evaluateMemoryAdmission({observation:{...good,expiry:'EXPIRED'}}).status, 'FAIL');
  assert.equal(evaluateMemoryAdmission({observation:{...good,scope:'UNKNOWN'}}).status, 'INCONCLUSIVE');
});

test('memory retrieval enforces scope and re-authorization boundaries', () => {
  const good = {provenance:'VERIFIED',verification:'VERIFIED',source_lineage:'verified-source',content_classification:'FACT',source_trust:'TRUSTED',integrity:'VERIFIED',scope:'WORKSPACE',session_id:'s1'};
  assert.equal(evaluateMemoryRetrieval({observation:good,retrieval_context:{workspace:'WORKSPACE',session:'s1'}}).status,'PASS');
  assert.equal(evaluateMemoryRetrieval({observation:good,retrieval_context:{workspace:'USER',session:'s1'}}).status,'FAIL');
  assert.equal(evaluateMemoryRetrieval({observation:{...good,content_classification:'INSTRUCTION'},retrieval_context:{workspace:'WORKSPACE',session:'s1'}}).status,'INCONCLUSIVE');
});

test('memory lifecycle blocks poisoned persistence before retrieval', () => {
  const good = {provenance:'VERIFIED',verification:'VERIFIED',source_lineage:'verified-source',content_classification:'FACT',source_trust:'TRUSTED',integrity:'VERIFIED',scope:'WORKSPACE',session_id:'s1',origin_binding:'BOUND',authority_class:'DATA'};
  assert.equal(evaluateMemoryLifecycle({candidate:good,persisted:good,retrieved:good,retrieval_context:{workspace:'WORKSPACE',session:'s1'}}).status,'PASS');
  const poisoned = {...good, poisoned:true};
  const blocked = evaluateMemoryLifecycle({candidate:good,persisted:poisoned,retrieved:poisoned,retrieval_context:{workspace:'WORKSPACE',session:'s1'}});
  assert.equal(blocked.status,'FAIL');
  assert.equal(blocked.stage,'PERSISTENCE');
});

test('memory authority is origin-bound and cannot self-authorize action', () => {
  const good = {origin_binding:'BOUND',authority_class:'DATA'};
  assert.equal(evaluateMemoryAuthority({observation:good,action:'READ'}).status,'PASS');
  assert.equal(evaluateMemoryAuthority({observation:good,action:'ACT'}).status,'FAIL');
  assert.equal(evaluateMemoryAuthority({observation:{...good,origin_binding:'UNBOUND'},action:'READ'}).status,'FAIL');
  assert.equal(evaluateMemoryAuthority({observation:{origin_binding:'BOUND'},action:'READ'}).status,'INCONCLUSIVE');
});

test('agent identity and delegated authorization fail closed', () => {
  const identity = {
    agent_id:'agent-A', trust_anchor:'VERIFIED', credential_status:'ACTIVE',
    credential_provenance:'VERIFIED', audience:'master-brain', expires_at:'VALID',
    revocation_status:'NOT_REVOKED', authorization_scope:['research.read']
  };
  assert.equal(evaluateAgentIdentityAuthorization({identity,request:{audience:'master-brain',scope:'research.read'}}).status,'PASS');
  assert.equal(evaluateAgentIdentityAuthorization({identity,request:{audience:'master-brain',scope:'payments.execute'}}).status,'FAIL');
  assert.equal(evaluateAgentIdentityAuthorization({identity:{...identity,revocation_status:'REVOKED'},request:{scope:'research.read'}}).status,'FAIL');
  assert.equal(evaluateAgentIdentityAuthorization({identity:{...identity,trust_anchor:'UNKNOWN'},request:{scope:'research.read'}}).status,'INCONCLUSIVE');
});

test('token lifecycle independently enforces issuer trust, temporal validity, revocation, scope, and sender binding', () => {
  const token = {
    token_id:'t1', issuer:'issuer-A', issuer_trust:'VERIFIED', signature_status:'VERIFIED',
    integrity:'VERIFIED', audience:'agent-A', issued_at:'VALID', expires_at:'VALID',
    revocation_status:'NOT_REVOKED', scope:['research.read']
  };
  assert.equal(evaluateTokenLifecycle({token,request:{audience:'agent-A',scope:'research.read'}}).status,'PASS');
  assert.equal(evaluateTokenLifecycle({token:{...token,issuer_trust:'UNKNOWN'},request:{scope:'research.read'}}).status,'INCONCLUSIVE');
  assert.equal(evaluateTokenLifecycle({token:{...token,issued_at:'INVALID'},request:{scope:'research.read'}}).status,'FAIL');
  assert.equal(evaluateTokenLifecycle({token:{...token,revocation_status:'REVOKED'},request:{scope:'research.read'}}).status,'FAIL');
  assert.equal(evaluateTokenLifecycle({token:{...token,audience:'other'},request:{audience:'agent-A'}}).status,'FAIL');
  assert.equal(evaluateTokenLifecycle({token:{...token,scope:['research.read']},request:{scope:'payments.execute'}}).status,'FAIL');
  assert.equal(evaluateTokenLifecycle({token:{...token,scope:['*']},request:{consequential:true}}).status,'FAIL');
  assert.equal(evaluateTokenLifecycle({token,request:{consequential:true}}).status,'INCONCLUSIVE');
  assert.equal(evaluateTokenLifecycle({token:{...token,sender_binding:'VERIFIED'},request:{consequential:true,scope:'research.read'}}).status,'PASS');
  assert.equal(evaluateTokenLifecycle({token:{...token,sender_binding:'VERIFIED',sender_binding_id:'key-A'},request:{consequential:true,scope:'research.read',sender_binding_id:'key-B'}}).status,'FAIL');
  assert.equal(evaluateTokenLifecycle({token:{...token,sender_binding:'VERIFIED',sender_binding_id:'key-A'},request:{consequential:true,scope:'research.read',sender_binding_id:'key-A'}}).status,'PASS');
});

test('authority propagation rejects laundering, widened delegation, lost provenance, and consequential execution', () => {
  const base = { authority:'DATA', provenance_binding:'PRESERVED', revocation_status:'NOT_REVOKED', consequential_action:'NOT_EXECUTED' };
  assert.equal(evaluateAuthorityPropagation({origin:{authority:'DATA'},transformations:[],delegation:[{parent_scope:['read'],child_scope:['read']}],final:base}).status,'PASS');
  assert.equal(evaluateAuthorityPropagation({origin:{authority:'DATA'},transformations:[{authority_upgrade:true}],final:base}).status,'FAIL');
  assert.equal(evaluateAuthorityPropagation({origin:{authority:'DATA'},transformations:[],delegation:[{parent_scope:['read'],child_scope:['read','write']}],final:base}).status,'FAIL');
  assert.equal(evaluateAuthorityPropagation({origin:{authority:'DATA'},transformations:[],delegation:[],final:{...base,provenance_binding:'REWRITTEN'}}).status,'INCONCLUSIVE');
  assert.equal(evaluateAuthorityPropagation({origin:{authority:'DATA'},transformations:[],delegation:[],final:{...base,revocation_status:'REVOKED'}}).status,'FAIL');
  assert.equal(evaluateAuthorityPropagation({origin:{authority:'DATA'},transformations:[],delegation:[],final:{...base,consequential_action:'EXECUTED'}}).status,'FAIL');
});

test('cryptographic intent binding rejects drift, widened scope, and unverified mandates', () => {
  const intent = {
    intent_id:'intent-1', principal_binding:'VERIFIED', signature_status:'VERIFIED',
    integrity:'VERIFIED', intent_hash:'ih1', task_hash:'th1', target:'sink-A',
    scope:['research.read'], constraints:{}
  };
  assert.equal(evaluateIntentBinding({intent,request:{intent_hash:'ih1',task_hash:'th1',target:'sink-A',scope:['research.read']}}).status,'PASS');
  assert.equal(evaluateIntentBinding({intent,request:{intent_hash:'ih2'}}).status,'FAIL');
  assert.equal(evaluateIntentBinding({intent,request:{task_hash:'th2'}}).status,'FAIL');
  assert.equal(evaluateIntentBinding({intent,request:{target:'sink-B'}}).status,'FAIL');
  assert.equal(evaluateIntentBinding({intent,request:{scope:['research.read','payments.execute']}}).status,'FAIL');
  assert.equal(evaluateIntentBinding({intent:{...intent,signature_status:'UNKNOWN'},request:{intent_hash:'ih1'}}).status,'INCONCLUSIVE');
  assert.equal(evaluateIntentBinding({intent:{...intent,principal_binding:'UNKNOWN'},request:{intent_hash:'ih1'}}).status,'INCONCLUSIVE');
  assert.equal(evaluateIntentBinding({intent,request:{constraint_violation:true}}).status,'FAIL');
  assert.equal(evaluateIntentBinding({intent:{...intent,scope:[]},request:{}}).status,'INCONCLUSIVE');
});

test('known-good controls pass', () => {
  assert.equal(evaluateExecutionProcess({trace:goodTrace, specification:{target:'sink-A'}}).status, 'PASS');
  assert.equal(evaluateCapabilityAdmission({capability:{status:'ACTIVE',provenance:'VERIFIED',integrity:'VERIFIED',compatibility:'COMPATIBLE'}}).status, 'PASS');
  assert.equal(evaluateMemoryAdmission({observation:{provenance:'VERIFIED',verification:'VERIFIED',source_lineage:'x'}}).status, 'PASS');
  assert.equal(evaluateMultiAgentPropagation({agents:[{status:'PASS',verification:'VERIFIED'}],final:{status:'PROCEED'}}).status, 'PASS');
});

test('workload tokens require short lifetime and verified key-rotation lifecycle when policy demands it', () => {
  const token = {
    token_id:'t-short', issuer:'issuer-A', issuer_trust:'VERIFIED', signature_status:'VERIFIED',
    integrity:'VERIFIED', audience:'agent-A', issued_at:'VALID', expires_at:'VALID',
    revocation_status:'NOT_REVOKED', scope:['research.read'],
    lifetime_seconds:300, key_rotation_status:'VERIFIED'
  };
  assert.equal(evaluateTokenLifecycle({
    token, request:{audience:'agent-A',scope:'research.read',require_short_lived:true,max_lifetime_seconds:900,require_key_rotation:true}
  }).status,'PASS');
  assert.equal(evaluateTokenLifecycle({
    token:{...token,lifetime_seconds:3600}, request:{require_short_lived:true,max_lifetime_seconds:900}
  }).status,'FAIL');
  assert.equal(evaluateTokenLifecycle({
    token:{...token,key_rotation_status:'UNKNOWN'}, request:{require_key_rotation:true}
  }).status,'INCONCLUSIVE');
  assert.equal(evaluateTokenLifecycle({
    token:{...token,key_rotation_status:'FAILED'}, request:{require_key_rotation:true}
  }).status,'FAIL');
});

test('agent credential sharing is rejected for accountable authorization', () => {
  const identity = {
    agent_id:'agent-1', trust_anchor:'VERIFIED', credential_status:'ACTIVE', credential_provenance:'VERIFIED',
    audience:'master-brain', expires_at:'VALID', revocation_status:'NOT_REVOKED', authorization_scope:['research.read'],
    credential_binding:'SHARED'
  };
  assert.equal(evaluateAgentIdentityAuthorization({identity,request:{audience:'master-brain',scope:'research.read'}}).status,'FAIL');
});
