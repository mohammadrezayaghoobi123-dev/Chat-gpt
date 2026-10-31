import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGovernance } from '../../master_brain/core/governance-core.mjs';

test('allows verified low-risk reversible decisions with satisfied oversight', () => {
  const result = evaluateGovernance({
    risk: { level: 'LOW', reversibility: 'REVERSIBLE' },
    evidence: { status: 'VERIFIED' },
    permission: { required: false },
    human_oversight: 'NONE',
  });
  assert.equal(result.status, 'ALLOW');
});

test('escalates high-risk decisions to human approval', () => {
  const result = evaluateGovernance({
    risk: { level: 'HIGH', reversibility: 'DIFFICULT' },
    evidence: { status: 'VERIFIED' },
    permission: { required: true },
    human_oversight: 'HUMAN_APPROVAL',
    approval: { granted: false },
  });
  assert.equal(result.status, 'ESCALATE');
  assert.equal(result.requires_approval, true);
});

test('holds when evidence is not verified', () => {
  const result = evaluateGovernance({
    risk: { level: 'LOW', reversibility: 'REVERSIBLE' },
    evidence: { status: 'UNVERIFIED' },
    permission: { required: false },
    human_oversight: 'NONE',
  });
  assert.equal(result.status, 'HOLD');
});

test('rejects critical actions without explicit approval', () => {
  const result = evaluateGovernance({
    risk: { level: 'CRITICAL', reversibility: 'IRREVERSIBLE' },
    evidence: { status: 'VERIFIED' },
    permission: { required: true },
    human_oversight: 'HUMAN_APPROVAL',
    approval: { granted: false },
  });
  assert.equal(result.status, 'REJECT');
});
