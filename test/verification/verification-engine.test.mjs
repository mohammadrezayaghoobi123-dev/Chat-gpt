import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAnalysis } from '../../master_brain/verification/verification-engine.mjs';

test('passes only when evidence, assumptions, contradictions and calculations are verified', () => {
  const result = verifyAnalysis({
    evidence: { status: 'VERIFIED' },
    assumptions: { high_impact_unverified: 0 },
    contradictions: { unresolved: 0 },
    calculations: { status: 'VALID' }
  });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.reasons.length, 0);
});

test('blocks verification when a critical gate is unresolved', () => {
  const result = verifyAnalysis({
    evidence: { status: 'VERIFIED' },
    assumptions: { high_impact_unverified: 1 },
    contradictions: { unresolved: 0 },
    calculations: { status: 'VALID' }
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons[0], /assumption/i);
});