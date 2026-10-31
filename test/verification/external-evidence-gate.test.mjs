import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExternalSecurityEvidence } from '../../master_brain/verification/harness/mcp-toolchain-security.mjs';

test('external scanner evidence cannot independently promote a critical security requirement to VERIFIED', () => {
  assert.equal(typeof evaluateExternalSecurityEvidence, 'function');
  assert.equal(evaluateExternalSecurityEvidence({ evidence:{source_type:'SCANNER',provenance:'VERIFIED',independent_reviewer:'ABSENT',corroboration:'NONE',finding_status:'CLEAN'} }).status,'INCONCLUSIVE');
  assert.equal(evaluateExternalSecurityEvidence({ evidence:{source_type:'SCANNER',provenance:'VERIFIED',independent_reviewer:'VERIFIED',corroboration:'INDEPENDENT',finding_status:'CLEAN'} }).status,'PASS');
});
