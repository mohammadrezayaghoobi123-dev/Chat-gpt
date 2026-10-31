import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidenceRequirement } from '../../master_brain/knowledge/evidence-requirement-engine.mjs';

test('requires stronger independent evidence for critical domains', () => {
  const result = assessEvidenceRequirement({
    evidence_requirement: 'CRITICAL',
    criticality: 'C4',
    risk: 'CRITICAL',
    decision_impact: 'HIGH',
  });
  assert.equal(result.min_independent_sources, 3);
  assert.equal(result.primary_source_required, true);
  assert.equal(result.specialist_review, true);
  assert.equal(result.devils_advocate, true);
});

test('uses moderate evidence requirements for medium-risk domains', () => {
  const result = assessEvidenceRequirement({
    evidence_requirement: 'MEDIUM',
    criticality: 'C2',
    risk: 'MEDIUM',
    decision_impact: 'MEDIUM',
  });
  assert.equal(result.min_independent_sources, 2);
  assert.equal(result.primary_source_required, false);
});

test('does not allow low-risk policy to override a critical domain', () => {
  const result = assessEvidenceRequirement({
    evidence_requirement: 'LOW',
    criticality: 'C4',
    risk: 'LOW',
    decision_impact: 'LOW',
  });
  assert.equal(result.min_independent_sources, 3);
  assert.equal(result.specialist_review, true);
});

test('rejects unknown requirement levels', () => {
  assert.throws(() => assessEvidenceRequirement({
    evidence_requirement: 'UNKNOWN',
    criticality: 'C0',
    risk: 'LOW',
    decision_impact: 'LOW',
  }), /invalid evidence requirement/);
});
