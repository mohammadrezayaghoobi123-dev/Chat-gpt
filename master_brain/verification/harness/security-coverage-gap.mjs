const RESULT = Object.freeze({
  VERIFIED: 'VERIFIED',
  PARTIAL: 'PARTIAL',
  UNTESTED: 'UNTESTED',
  UNKNOWN: 'UNKNOWN'
});

const DEFAULT_SECURITY_COVERAGE_REQUIREMENTS = Object.freeze([
  {requirement_id:'web-execution', domain:'attack_surface', criticality:'HIGH', required_roles:['attack_surface','execution_boundary']},
  {requirement_id:'api-execution', domain:'attack_surface', criticality:'HIGH', required_roles:['attack_surface','execution_boundary']},
  {requirement_id:'identity-authentication', domain:'trust_boundary', criticality:'CRITICAL', required_roles:['identity','authorization','revocation']},
  {requirement_id:'prompt-injection', domain:'agent-security', criticality:'CRITICAL', required_roles:['indirect_input','tool_boundary','adversarial_campaign']},
  {requirement_id:'memory-poisoning', domain:'agent-security', criticality:'CRITICAL', required_roles:['memory_write','memory_retrieval','provenance']},
  {requirement_id:'multi-agent-propagation', domain:'multi-agent', criticality:'CRITICAL', required_roles:['propagation','trust_boundary','adversarial_campaign']},
  {requirement_id:'long-horizon', domain:'agent-security', criticality:'HIGH', required_roles:['state','sequence','adversarial_campaign']},
  {requirement_id:'recovery-paths', domain:'resilience', criticality:'CRITICAL', required_roles:['crash','replay','integrity','independent_comparison']},
  {requirement_id:'supply-chain', domain:'supply-chain', criticality:'HIGH', required_roles:['artifact_provenance','dependency_integrity','mutation']},
  {requirement_id:'dark-web-intel', domain:'threat-intelligence', criticality:'HIGH', required_roles:['source_provenance','corroboration','payload_safety','isolation']},
  {requirement_id:'tool-poisoning', domain:'agent-security', criticality:'CRITICAL', required_roles:['tool_provenance','response_sanitization','execution_boundary']},
  {requirement_id:'authority-propagation', domain:'authorization', criticality:'CRITICAL', required_roles:['origin_binding','delegation','scope_attenuation','revocation']},
  {requirement_id:'mcp-toolchain-security', domain:'mcp', criticality:'CRITICAL', required_roles:['server_identity','capability_attestation','server_artifact_integrity','dependency_integrity','tool_provenance','response_sanitization','scope_enforcement','command_execution_boundary','audit_telemetry','tool_definition_integrity','replay_transaction_binding','cross_server_flow_control','schema_validation','origin_validation','host_validation','resource_controls','audience_binding','secret_leakage_control']}
]);

function normalizeEvidence(evidence = []) {
  const map = new Map();
  for (const item of evidence) {
    if (!item?.requirement_id) continue;
    const current = map.get(item.requirement_id) ?? {roles:new Set(), states:[]};
    for (const role of Array.isArray(item.evidence_roles) ? item.evidence_roles : []) current.roles.add(role);
    current.states.push(item.verified);
    map.set(item.requirement_id, current);
  }
  return map;
}

function assessRequirement(requirement, evidence) {
  const item = evidence.get(requirement.requirement_id);
  if (!item) return { ...requirement, status: RESULT.UNTESTED, missing_roles:[...requirement.required_roles] };
  if (item.states.some(value => value === false || value === 'UNKNOWN' || value === 'CONFLICTED')) {
    return { ...requirement, status: RESULT.UNKNOWN, missing_roles:requirement.required_roles.filter(role => !item.roles.has(role)) };
  }
  const missing_roles = requirement.required_roles.filter(role => !item.roles.has(role));
  if (missing_roles.length) return { ...requirement, status: RESULT.PARTIAL, missing_roles };
  if (!item.states.length || item.states.some(value => value !== true)) {
    return { ...requirement, status: RESULT.UNKNOWN, missing_roles:[] };
  }
  return { ...requirement, status: RESULT.VERIFIED, missing_roles:[] };
}

export function assessSecurityCoverage({ evidence = [], requirements = DEFAULT_SECURITY_COVERAGE_REQUIREMENTS } = {}) {
  const normalized = normalizeEvidence(evidence);
  const requirementsOut = requirements.map(requirement => assessRequirement(requirement, normalized));
  const gaps = requirementsOut.filter(item => item.status !== RESULT.VERIFIED).map(item => ({
    requirement_id:item.requirement_id,
    domain:item.domain,
    criticality:item.criticality,
    status:item.status,
    missing_roles:item.missing_roles
  }));
  const critical_unresolved = requirementsOut
    .filter(item => item.criticality === 'CRITICAL' && item.status !== RESULT.VERIFIED)
    .map(item => item.requirement_id);
  return {
    status: gaps.length ? 'GAPS_PRESENT' : RESULT.VERIFIED,
    ready: critical_unresolved.length === 0,
    requirements: requirementsOut,
    gaps,
    critical_unresolved,
    summary: {
      total: requirementsOut.length,
      verified: requirementsOut.filter(x => x.status === RESULT.VERIFIED).length,
      partial: requirementsOut.filter(x => x.status === RESULT.PARTIAL).length,
      untested: requirementsOut.filter(x => x.status === RESULT.UNTESTED).length,
      unknown: requirementsOut.filter(x => x.status === RESULT.UNKNOWN).length
    }
  };
}

export { RESULT, DEFAULT_SECURITY_COVERAGE_REQUIREMENTS };
