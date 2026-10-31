const RESULT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE' });

const REQUIRED = Object.freeze([
  'server_identity',
  'capability_attestation',
  'server_artifact_integrity',
  'dependency_integrity',
  'tool_provenance',
  'response_sanitization',
  'scope_enforcement',
  'command_execution_boundary',
  'audit_telemetry',
  'tool_definition_integrity',
  'replay_transaction_binding',
  'cross_server_flow_control',
  'schema_validation',
  'origin_validation',
  'host_validation',
  'resource_controls',
  'audience_binding',
  'secret_leakage_control'
]);

export function evaluateMcpToolchainSecurity({ invocation = {}, server = {}, policy = {}, response = {}, tool = {} } = {}) {
  const evidence = {
    server_identity: server.identity_status,
    capability_attestation: server.capability_attestation,
    server_artifact_integrity: server.artifact_hash !== undefined && server.approved_artifact_hash !== undefined && server.artifact_hash === server.approved_artifact_hash ? 'VERIFIED' : undefined,
    dependency_integrity: server.dependency_lock_hash !== undefined && server.approved_dependency_lock_hash !== undefined && server.dependency_lock_hash === server.approved_dependency_lock_hash ? 'VERIFIED' : undefined,
    tool_provenance: invocation.tool_provenance,
    response_sanitization: response.classification === 'SANITIZED_DATA' ? 'VERIFIED' : response.classification,
    scope_enforcement: policy.scope_status,
    command_execution_boundary: policy.execution_boundary,
    audit_telemetry: invocation.audit_status,
    tool_definition_integrity: tool.schema_hash !== undefined && tool.approved_schema_hash !== undefined && tool.schema_hash === tool.approved_schema_hash && tool.version !== undefined && tool.approved_version !== undefined && tool.version === tool.approved_version ? 'VERIFIED' : undefined,
    replay_transaction_binding: invocation.replay_status,
    cross_server_flow_control: policy.cross_server_flow,
    schema_validation: policy.schema_validation,
    origin_validation: policy.origin_validation,
    host_validation: policy.host_validation,
    resource_controls: policy.resource_controls,
    audience_binding: policy.audience_binding,
    secret_leakage_control: response.secret_status === 'NO_SENSITIVE_SECRETS' ? 'VERIFIED' : response.secret_status
  };

  if (server.identity_status !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'MCP server identity is not verified' };
  if (!server.server_id || !server.approved_server_id || server.server_id !== server.approved_server_id) return { status: RESULT.FAIL, reason: 'MCP server identity binding mismatch' };
  if (server.capability_attestation === 'FAILED') return { status: RESULT.FAIL, reason: 'MCP capability attestation failed' };
  if (evidence.capability_attestation !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'MCP capability attestation is not verified' };
  if (evidence.server_artifact_integrity !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'MCP server artifact integrity is not verified' };
  if (evidence.dependency_integrity !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'MCP dependency integrity is not verified' };
  if (!tool.server_id || !tool.approved_server_id || tool.server_id !== tool.approved_server_id) return { status: RESULT.FAIL, reason: 'MCP tool/server binding mismatch' };
  if (!tool.tool_id || !tool.approved_tool_id || tool.tool_id !== tool.approved_tool_id) return { status: RESULT.FAIL, reason: 'MCP tool identity binding mismatch' };
  if (!tool.schema_hash || !tool.approved_schema_hash || tool.schema_hash !== tool.approved_schema_hash) return { status: RESULT.FAIL, reason: 'MCP tool definition schema integrity mismatch' };
  if (!tool.version || !tool.approved_version || tool.version !== tool.approved_version) return { status: RESULT.FAIL, reason: 'MCP tool definition version mismatch' };
  if (invocation.consequential === true) {
    if (!invocation.intent_hash || !invocation.request_intent_hash || invocation.intent_hash !== invocation.request_intent_hash) return { status: RESULT.FAIL, reason: 'MCP signed intent binding mismatch' };
    if (!invocation.transaction_id || !invocation.bound_transaction_id || invocation.transaction_id !== invocation.bound_transaction_id) return { status: RESULT.FAIL, reason: 'MCP transaction binding mismatch' };
  }
  if (policy.scope_status === 'VIOLATED') return { status: RESULT.FAIL, reason: 'MCP authorization scope is violated' };
  if (['VIOLATED','CREDENTIAL_FLOW','FORBIDDEN'].includes(policy.cross_server_flow)) return { status: RESULT.FAIL, reason: 'MCP cross-server data-flow boundary violated' };
  if (invocation.replay_status === 'REPLAY_DETECTED') return { status: RESULT.FAIL, reason: 'MCP replay detected' };

  if (response.secret_status === 'SENSITIVE_DATA_DETECTED') return { status: RESULT.FAIL, reason: 'sensitive secret leakage detected in MCP response' };

  if (response.classification === 'PROMPT_INJECTION' || response.classification === 'MALICIOUS') return { status: RESULT.FAIL, reason: 'hostile MCP response detected' };

  const missing = REQUIRED.filter((key) => evidence[key] === undefined);
  if (missing.length) {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP security evidence is incomplete', missing };
  }

  if (server.identity_status !== 'VERIFIED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP server identity is not verified' };
  }
  if (evidence.replay_transaction_binding === 'REPLAY_DETECTED') {
    return { status: RESULT.FAIL, reason: 'MCP replay detected' };
  }
  if (evidence.replay_transaction_binding !== 'FRESH_BOUND') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP transaction binding is not proven fresh' };
  }
  if (evidence.cross_server_flow_control === 'VIOLATED') {
    return { status: RESULT.FAIL, reason: 'MCP cross-server data-flow boundary violated' };
  }
  if (evidence.cross_server_flow_control !== 'ALLOWED_ISOLATED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP cross-server data-flow isolation is not proven' };
  }
  if (invocation.tool_provenance !== 'VERIFIED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP tool provenance is not verified' };
  }
  if (response.secret_status === 'SENSITIVE_DATA_DETECTED') {
    return { status: RESULT.FAIL, reason: 'sensitive secret leakage detected in MCP response' };
  }
  if (response.classification === 'PROMPT_INJECTION' || response.classification === 'MALICIOUS') {
    return { status: RESULT.FAIL, reason: 'hostile MCP response detected' };
  }
  if (response.classification !== 'SANITIZED_DATA') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP response is not proven to be sanitized data' };
  }
  if (policy.host_validation === 'UNEXPECTED' || policy.host_validation === 'INVALID') {
    return { status: RESULT.FAIL, reason: 'MCP Host header validation failed' };
  }
  if (policy.resource_controls === 'VIOLATED') {
    return { status: RESULT.FAIL, reason: 'MCP resource-control boundary violated' };
  }
  if (policy.schema_validation !== 'VERIFIED' || policy.origin_validation !== 'VERIFIED' || policy.host_validation !== 'VERIFIED' || policy.resource_controls !== 'VERIFIED' || policy.audience_binding !== 'VERIFIED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP schema/origin/host/audience validation is not fully verified' };
  }
  if (policy.schema_validation_evidence) {
    const s = policy.schema_validation_evidence;
    const required = ['unknown_fields_rejected','types_enforced','enums_patterns_enforced','size_depth_limits_enforced','canonicalization_applied'];
    if (required.some((key) => s[key] !== true) || s.side_effect_order !== 'VALIDATE_BEFORE_SIDE_EFFECT') {
      return { status: RESULT.INCONCLUSIVE, reason: 'MCP strict schema validation evidence is incomplete or ordered after side effects' };
    }
  }
  if (response.secret_status !== 'NO_SENSITIVE_SECRETS') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP secret leakage control is not verified' };
  }
  if (policy.scope_status !== 'BOUNDED') {
    return { status: policy.scope_status === 'VIOLATED' ? RESULT.FAIL : RESULT.INCONCLUSIVE, reason: 'MCP authorization scope is not safely bounded' };
  }
  if (policy.execution_boundary !== 'ISOLATED_ALLOWLIST') {
    return { status: policy.execution_boundary === 'VIOLATED' ? RESULT.FAIL : RESULT.INCONCLUSIVE, reason: 'MCP command execution boundary is not safely isolated' };
  }
  if (invocation.audit_status !== 'VERIFIED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP audit telemetry is not verified' };
  }

  return { status: RESULT.PASS, evidence };
}

export function evaluateMcpToolAdmission({ server = {}, tool = {} } = {}) {
  if (server.identity_status === 'REVOKED' || server.status === 'DISABLED') {
    return { status: RESULT.FAIL, reason: 'MCP server is revoked or disabled' };
  }
  if (server.identity_status !== 'VERIFIED' || server.provenance !== 'VERIFIED' || server.integrity !== 'VERIFIED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP server trust is not fully verified' };
  }
  if (server.artifact_hash === undefined || server.approved_artifact_hash === undefined || server.dependency_lock_hash === undefined || server.approved_dependency_lock_hash === undefined) {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP server artifact/dependency integrity is not independently verified' };
  }
  if (server.artifact_hash !== server.approved_artifact_hash) {
    return { status: RESULT.FAIL, reason: 'MCP server artifact integrity mismatch' };
  }
  if (server.dependency_lock_hash !== server.approved_dependency_lock_hash) {
    return { status: RESULT.FAIL, reason: 'MCP dependency integrity mismatch' };
  }
  if (tool.provenance !== 'VERIFIED' || tool.integrity !== 'VERIFIED') {
    return { status: RESULT.INCONCLUSIVE, reason: 'MCP tool trust is not fully verified' };
  }
  if (tool.permission_declaration !== 'MATCHES_IMPLEMENTATION') {
    return { status: RESULT.FAIL, reason: 'MCP declared permissions do not match implementation' };
  }
  if (tool.consequential === true && tool.scope === '*') {
    return { status: RESULT.FAIL, reason: 'wildcard MCP scope is forbidden for consequential tools' };
  }
  return { status: RESULT.PASS };
}

export function evaluateExternalSecurityEvidence({ evidence = {} } = {}) {
  if (evidence.finding_status === 'RISK') return { status: RESULT.FAIL, reason: 'external evidence reports a security risk' };
  if (evidence.source_type === 'SCANNER' && evidence.finding_status === 'CLEAN') {
    if (evidence.provenance !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'scanner provenance is not verified' };
    if (evidence.independent_reviewer !== 'VERIFIED') return { status: RESULT.INCONCLUSIVE, reason: 'scanner result lacks independent review' };
    if (evidence.corroboration !== 'INDEPENDENT') return { status: RESULT.INCONCLUSIVE, reason: 'scanner result lacks independent corroboration' };
    return { status: RESULT.PASS, reason: 'scanner result is independently reviewed and corroborated' };
  }
  return { status: RESULT.INCONCLUSIVE, reason: 'external security evidence is insufficient or unclassified' };
}

export { RESULT, REQUIRED };
