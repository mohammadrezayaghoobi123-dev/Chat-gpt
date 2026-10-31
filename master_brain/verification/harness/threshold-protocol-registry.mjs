const REQUIRED_EVIDENCE = [
  'technical_specification','reference_implementation','test_vectors','independent_review',
  'share_lifecycle','malicious_participant_tests','replay_binding_tests','recovery_tests',
  'key_rotation_tests','performance_evaluation','fresh_environment_reproduction',
];

function registerThresholdProtocol({id,version,primitive,security_model,status='CANDIDATE',
  evidence={},secret_shared=false,reconstructible_private_key_in_normal_operation=true}={}) {
  if (!id || !version || !primitive || !security_model) throw new Error('INCOMPLETE_THRESHOLD_PROTOCOL');
  return {id,version,primitive,security_model,status,evidence:{...evidence},secret_shared,
    reconstructible_private_key_in_normal_operation};
}

function evaluateThresholdProtocolQualification(protocol={}) {
  if (!protocol.id || !protocol.version || !protocol.primitive || !protocol.security_model)
    return {status:'INCONCLUSIVE',reason:'INCOMPLETE_PROTOCOL_IDENTITY'};
  if (protocol.status==='REVOKED' || protocol.status==='QUARANTINED')
    return {status:'FAIL',reason:'PROTOCOL_NOT_DEPLOYABLE'};
  const missing=REQUIRED_EVIDENCE.filter(k=>protocol.evidence?.[k]!=='VERIFIED');
  if (protocol.secret_shared!==true)
    return {status:'INCONCLUSIVE',reason:'SECRET_SHARING_NOT_VERIFIED',missing};
  if (protocol.reconstructible_private_key_in_normal_operation!==false)
    return {status:'INCONCLUSIVE',reason:'SINGLE_KEY_RECONSTRUCTION_NOT_EXCLUDED',missing};
  if (missing.length) return {status:'INCONCLUSIVE',reason:'QUALIFICATION_EVIDENCE_INCOMPLETE',missing};
  if (protocol.status!=='ACTIVE') return {status:'INCONCLUSIVE',reason:'PROTOCOL_NOT_ACTIVE',missing};
  return {status:'PASS',protocol_id:protocol.id,version:protocol.version,
    primitive:protocol.primitive,security_model:protocol.security_model};
}
export {REQUIRED_EVIDENCE,registerThresholdProtocol,evaluateThresholdProtocolQualification};
