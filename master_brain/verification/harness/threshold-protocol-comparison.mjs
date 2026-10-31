const COMPARISON_CRITERIA = Object.freeze([
  'security_model','adaptive_security','dkg','share_lifecycle','malicious_participants','liveness_dos',
  'nonce_session_transcript_safety','replay_resistance','recovery','rotation_revocation','pqc_readiness',
  'implementation_maturity','independent_review','test_vectors_interoperability','performance_resource',
  'deployment_rights','negative_evidence','independent_reproduction'
]);

const STATUS = Object.freeze({QUALIFIED:'QUALIFIED', CANDIDATE:'CANDIDATE', HOLD:'HOLD', REJECT:'REJECT'});

function evaluateProtocolCandidate(candidate={}) {
  if (!candidate.id || !candidate.version) return {status:STATUS.HOLD, reason:'INCOMPLETE_IDENTITY'};
  if (candidate.revoked === true || candidate.quarantined === true) return {status:STATUS.REJECT, reason:'DEPLOYMENT_BLOCKED'};

  const missing = COMPARISON_CRITERIA.filter(k => candidate.criteria?.[k] !== 'VERIFIED');
  const negativeRisk = candidate.negative_evidence === 'UNRESOLVED_RISK';
  const reproduction = candidate.criteria?.independent_reproduction === 'VERIFIED';

  if (negativeRisk) return {status:STATUS.REJECT, reason:'UNRESOLVED_NEGATIVE_EVIDENCE', missing};
  if (missing.length) return {status:STATUS.HOLD, reason:'COMPARISON_EVIDENCE_INCOMPLETE', missing};
  if (!reproduction) return {status:STATUS.HOLD, reason:'INDEPENDENT_REPRODUCTION_REQUIRED'};

  const artifact = candidate.artifact ?? {};
  if (artifact.status !== 'VERIFIED' || artifact.version !== candidate.version ||
      typeof artifact.content_hash !== 'string' || !/^sha256:[0-9a-f]{8,}$/i.test(artifact.content_hash)) {
    return {status:STATUS.HOLD, reason:'EXACT_VERSIONED_ARTIFACT_NOT_VERIFIED'};
  }

  if (candidate.evidence_freshness !== 'VERIFIED') {
    return {status:STATUS.HOLD, reason:'EVIDENCE_FRESHNESS_NOT_VERIFIED'};
  }

  const mesh = candidate.evidence_mesh ?? {};
  if (mesh.status !== 'PASS' || !Number.isInteger(mesh.independent_lineages) || mesh.independent_lineages < 3) {
    return {status:STATUS.HOLD, reason:'INDEPENDENT_EVIDENCE_MESH_NOT_VERIFIED'};
  }

  if (candidate.security_assumptions !== 'VERIFIED') {
    return {status:STATUS.HOLD, reason:'SECURITY_ASSUMPTIONS_NOT_VERIFIED'};
  }

  return {
    status:STATUS.QUALIFIED,
    id:candidate.id,
    version:candidate.version,
    artifact_hash:artifact.content_hash,
    independent_lineages:mesh.independent_lineages
  };
}

function rankCandidates(candidates=[]) {
  return candidates.map(c => ({candidate:c, evaluation:evaluateProtocolCandidate(c)}))
    .sort((a,b) => {
      const order={QUALIFIED:0,CANDIDATE:1,HOLD:2,REJECT:3};
      return order[a.evaluation.status]-order[b.evaluation.status];
    });
}

export {COMPARISON_CRITERIA,STATUS,evaluateProtocolCandidate,rankCandidates};
