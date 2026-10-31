import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMcpToolchainSecurity, evaluateMcpToolAdmission } from '../../master_brain/verification/harness/mcp-toolchain-security.mjs';

const base = {
  invocation: { tool_provenance:'VERIFIED', audit_status:'VERIFIED', replay_status:'FRESH_BOUND', consequential:true, intent_hash:'intent-A', request_intent_hash:'intent-A', transaction_id:'tx-1', bound_transaction_id:'tx-1' },
  server: { identity_status:'VERIFIED', capability_attestation:'VERIFIED', server_id:'server-A', approved_server_id:'server-A', artifact_hash:'artifact-A', approved_artifact_hash:'artifact-A', dependency_lock_hash:'deps-A', approved_dependency_lock_hash:'deps-A' },
  policy: { scope_status:'BOUNDED', execution_boundary:'ISOLATED_ALLOWLIST', cross_server_flow:'ALLOWED_ISOLATED', schema_validation:'VERIFIED', origin_validation:'VERIFIED', host_validation:'VERIFIED', resource_controls:'VERIFIED', audience_binding:'VERIFIED' },
  response: { classification:'SANITIZED_DATA', secret_status:'NO_SENSITIVE_SECRETS' },
  tool: { server_id:'server-A', approved_server_id:'server-A', tool_id:'tool-1', approved_tool_id:'tool-1', schema_hash:'approved', approved_schema_hash:'approved', version:'1.2.0', approved_version:'1.2.0' }
};

test('MCP toolchain passes only when all independent security boundaries are verified', () => {
  assert.equal(evaluateMcpToolchainSecurity(base).status, 'PASS');
});

test('MCP server identity failure cannot be overridden by model/tool output', () => {
  const result = evaluateMcpToolchainSecurity({...base, server:{identity_status:'UNKNOWN'}});
  assert.equal(result.status, 'INCONCLUSIVE');
});

test('malicious or prompt-injection MCP output fails closed', () => {
  for (const classification of ['MALICIOUS','PROMPT_INJECTION']) {
    const result = evaluateMcpToolchainSecurity({...base, response:{classification}});
    assert.equal(result.status, 'FAIL');
  }
});

test('unbounded or violated MCP scope cannot authorize execution', () => {
  assert.equal(evaluateMcpToolchainSecurity({...base, policy:{scope_status:'UNBOUNDED', execution_boundary:'ISOLATED_ALLOWLIST'}}).status, 'INCONCLUSIVE');
  assert.equal(evaluateMcpToolchainSecurity({...base, policy:{scope_status:'VIOLATED', execution_boundary:'ISOLATED_ALLOWLIST'}}).status, 'FAIL');
});

test('MCP command execution requires an isolated allowlist boundary', () => {
  assert.equal(evaluateMcpToolchainSecurity({...base, policy:{scope_status:'BOUNDED', execution_boundary:'ARBITRARY_SHELL'}}).status, 'INCONCLUSIVE');
});

test('MCP tool admission rejects permission declaration mismatch and wildcard consequential scope', () => {
  const server = {identity_status:'VERIFIED', provenance:'VERIFIED', integrity:'VERIFIED', artifact_hash:'artifact-A', approved_artifact_hash:'artifact-A', dependency_lock_hash:'deps-A', approved_dependency_lock_hash:'deps-A'};
  assert.equal(evaluateMcpToolAdmission({server, tool:{provenance:'VERIFIED',integrity:'VERIFIED',permission_declaration:'MISMATCH'}}).status, 'FAIL');
  assert.equal(evaluateMcpToolAdmission({server, tool:{provenance:'VERIFIED',integrity:'VERIFIED',permission_declaration:'MATCHES_IMPLEMENTATION',consequential:true,scope:'*'}}).status, 'FAIL');
});

test('MCP tool admission accepts a verified least-privilege tool', () => {
  const server = {identity_status:'VERIFIED', provenance:'VERIFIED', integrity:'VERIFIED', artifact_hash:'artifact-A', approved_artifact_hash:'artifact-A', dependency_lock_hash:'deps-A', approved_dependency_lock_hash:'deps-A'};
  const tool = {provenance:'VERIFIED', integrity:'VERIFIED', permission_declaration:'MATCHES_IMPLEMENTATION', consequential:true, scope:['read:workspace']};
  assert.equal(evaluateMcpToolAdmission({server, tool}).status, 'PASS');
});


test('MCP tool definition integrity is pinned and changes are rejected', () => {
  const approved = evaluateMcpToolchainSecurity({...base, tool:{server_id:'server-A', approved_server_id:'server-A', tool_id:'tool-1', approved_tool_id:'tool-1', schema_hash:'approved', approved_schema_hash:'approved', version:'1.2.0', approved_version:'1.2.0'}});
  assert.equal(approved.status, 'PASS');
  const changed = evaluateMcpToolchainSecurity({...base, tool:{server_id:'server-A', approved_server_id:'server-A', tool_id:'tool-1', approved_tool_id:'tool-1', schema_hash:'changed', approved_schema_hash:'approved', version:'1.2.0', approved_version:'1.2.0'}});
  assert.equal(changed.status, 'FAIL');
});

test('MCP definition integrity binds the approved server and tool identity', () => {
  const result = evaluateMcpToolchainSecurity({...base,
    server:{identity_status:'VERIFIED', capability_attestation:'VERIFIED', server_id:'server-A', approved_server_id:'server-A', artifact_hash:'artifact-A', approved_artifact_hash:'artifact-A', dependency_lock_hash:'deps-A', approved_dependency_lock_hash:'deps-A'},
    tool:{server_id:'server-B', approved_server_id:'server-A', tool_id:'tool-1', approved_tool_id:'tool-1', schema_hash:'approved', approved_schema_hash:'approved', version:'1.2.0', approved_version:'1.2.0'}
  });
  assert.equal(result.status, 'FAIL');
});

test('MCP consequential execution requires transaction binding to the signed intent', () => {
  const result = evaluateMcpToolchainSecurity({...base,
    invocation:{tool_provenance:'VERIFIED', audit_status:'VERIFIED', replay_status:'FRESH_BOUND', consequential:true, intent_hash:'intent-A', request_intent_hash:'intent-B', transaction_id:'tx-1', bound_transaction_id:'tx-1'}
  });
  assert.equal(result.status, 'FAIL');
});

test('MCP cross-server credential flow is denied even when both servers are individually trusted', () => {
  const result = evaluateMcpToolchainSecurity({...base, policy:{scope_status:'BOUNDED', execution_boundary:'ISOLATED_ALLOWLIST', cross_server_flow:'CREDENTIAL_FLOW'}});
  assert.equal(result.status, 'FAIL');
});

test('MCP admission rejects a server without independently verified artifact and dependency integrity', () => {
  const server = {identity_status:'VERIFIED', provenance:'VERIFIED', integrity:'VERIFIED'};
  const tool = {provenance:'VERIFIED', integrity:'VERIFIED', permission_declaration:'MATCHES_IMPLEMENTATION', consequential:true, scope:['read:workspace']};
  assert.equal(evaluateMcpToolAdmission({server, tool}).status, 'INCONCLUSIVE');
});

test('MCP admission rejects artifact or dependency tampering', () => {
  const tool = {provenance:'VERIFIED', integrity:'VERIFIED', permission_declaration:'MATCHES_IMPLEMENTATION', consequential:true, scope:['read:workspace']};
  const artifactTampered = {identity_status:'VERIFIED', provenance:'VERIFIED', integrity:'VERIFIED', artifact_hash:'bad', approved_artifact_hash:'good', dependency_lock_hash:'deps', approved_dependency_lock_hash:'deps'};
  const dependencyTampered = {identity_status:'VERIFIED', provenance:'VERIFIED', integrity:'VERIFIED', artifact_hash:'artifact', approved_artifact_hash:'artifact', dependency_lock_hash:'bad', approved_dependency_lock_hash:'good'};
  assert.equal(evaluateMcpToolAdmission({server:artifactTampered, tool}).status, 'FAIL');
  assert.equal(evaluateMcpToolAdmission({server:dependencyTampered, tool}).status, 'FAIL');
});

test('MCP rejects an unexpected Host even when Origin and audience are valid', () => {
  const result = evaluateMcpToolchainSecurity({...base, policy:{...base.policy, host_validation:'UNEXPECTED'}});
  assert.equal(result.status, 'FAIL');
});

test('MCP requires independently verified capability attestation', () => {
  const result = evaluateMcpToolchainSecurity({...base, server:{...base.server, capability_attestation:'UNVERIFIED'}});
  assert.equal(result.status, 'INCONCLUSIVE');
});

test('MCP rejects a failed capability attestation', () => {
  const result = evaluateMcpToolchainSecurity({...base, server:{...base.server, capability_attestation:'FAILED'}});
  assert.equal(result.status, 'FAIL');
});

test('MCP requires verified per-session/tenant resource controls', () => {
  const result = evaluateMcpToolchainSecurity({...base, policy:{...base.policy, resource_controls:'UNVERIFIED'}});
  assert.equal(result.status, 'INCONCLUSIVE');
});

test('MCP rejects an explicitly violated resource-control boundary', () => {
  const result = evaluateMcpToolchainSecurity({...base, policy:{...base.policy, resource_controls:'VIOLATED'}});
  assert.equal(result.status, 'FAIL');
});

test('MCP requires strict schema validation, origin validation, audience binding, and secret-leakage control', () => {
  const unsafe = {...base, policy:{...base.policy, schema_validation:'UNVERIFIED', origin_validation:'VERIFIED', audience_binding:'VERIFIED'}, response:{classification:'SANITIZED_DATA', secret_status:'NO_SENSITIVE_SECRETS'}};
  assert.equal(evaluateMcpToolchainSecurity(unsafe).status, 'INCONCLUSIVE');
  assert.equal(evaluateMcpToolchainSecurity({...base, policy:{...base.policy, schema_validation:'VERIFIED', origin_validation:'VERIFIED', audience_binding:'VERIFIED'}, response:{classification:'SANITIZED_DATA', secret_status:'SENSITIVE_DATA_DETECTED'}}).status, 'FAIL');
});

test('MCP strict schema evidence proves rejection policy and validation occurred before side effects', () => {
  const strict = {...base, policy:{...base.policy, schema_validation:'VERIFIED', schema_validation_evidence:{
    unknown_fields_rejected:true,
    types_enforced:true,
    enums_patterns_enforced:true,
    size_depth_limits_enforced:true,
    canonicalization_applied:true,
    side_effect_order:'VALIDATE_BEFORE_SIDE_EFFECT'
  }}};
  assert.equal(evaluateMcpToolchainSecurity(strict).status, 'PASS');
});
