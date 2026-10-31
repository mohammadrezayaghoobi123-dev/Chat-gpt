import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessSecurityCoverage,
  DEFAULT_SECURITY_COVERAGE_REQUIREMENTS
} from '../../master_brain/verification/harness/security-coverage-gap.mjs';

test('security coverage reports every required attack domain and distinguishes verified, partial, untested, and unknown', () => {
  const result = assessSecurityCoverage({
    evidence: [
      {requirement_id:'web-execution', evidence_roles:['attack_surface','execution_boundary'], verified:true},
      {requirement_id:'dark-web-intel', evidence_roles:['source_provenance','corroboration'], verified:true},
      {requirement_id:'multi-agent-propagation', evidence_roles:['propagation','trust_boundary'], verified:false},
      {requirement_id:'supply-chain', evidence_roles:['artifact_provenance'], verified:true}
    ]
  });
  assert.equal(result.requirements.find(x=>x.requirement_id==='web-execution').status, 'VERIFIED');
  assert.equal(result.requirements.find(x=>x.requirement_id==='dark-web-intel').status, 'PARTIAL');
  assert.equal(result.requirements.find(x=>x.requirement_id==='multi-agent-propagation').status, 'UNKNOWN');
  assert.equal(result.requirements.find(x=>x.requirement_id==='recovery-paths').status, 'UNTESTED');
  assert.ok(result.gaps.some(x=>x.requirement_id==='recovery-paths'));
});

test('critical unverified coverage cannot be reported as ready', () => {
  const result = assessSecurityCoverage({
    evidence: [
      {requirement_id:'multi-agent-propagation', evidence_roles:['propagation','trust_boundary','adversarial_campaign'], verified:false}
    ]
  });
  assert.equal(result.ready, false);
  assert.ok(result.critical_unresolved.includes('multi-agent-propagation'));
});

test('unknown evidence is preserved as UNKNOWN rather than silently downgraded to untested', () => {
  const result = assessSecurityCoverage({
    evidence: [
      {requirement_id:'long-horizon', evidence_roles:['state','sequence'], verified:'UNKNOWN'}
    ]
  });
  assert.equal(result.requirements.find(x=>x.requirement_id==='long-horizon').status, 'UNKNOWN');
});

test('dark web remains a first-class security coverage requirement', () => {
  assert.ok(DEFAULT_SECURITY_COVERAGE_REQUIREMENTS.some(x=>x.requirement_id==='dark-web-intel'));
});

test('MCP coverage registry includes every independently enforced security boundary', () => {
  const requirement = DEFAULT_SECURITY_COVERAGE_REQUIREMENTS.find(x=>x.requirement_id==='mcp-toolchain-security');
  assert.deepEqual(requirement.required_roles, [
    'server_identity','capability_attestation','server_artifact_integrity','dependency_integrity','tool_provenance',
    'response_sanitization','scope_enforcement','command_execution_boundary','audit_telemetry',
    'tool_definition_integrity','replay_transaction_binding','cross_server_flow_control',
    'schema_validation','origin_validation','host_validation','resource_controls','audience_binding','secret_leakage_control'
  ]);
});
