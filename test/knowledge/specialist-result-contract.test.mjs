import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpecialistResult } from '../../master_brain/knowledge/specialist-result-contract.mjs';

test('creates an auditable specialist result with claims, evidence and uncertainty', () => {
  const result = createSpecialistResult({
    specialist_id: 'polymer-1',
    capability: 'polymer',
    model_id: 'chem-a',
    claims: [{ id: 'c1', statement: 'claim', status: 'INFERENCE' }],
    evidence: [{ source_id: 'paper-1', lineage_id: 'paper-1', quality: 0.9 }],
    uncertainty: [{ type: 'data', level: 'MEDIUM' }],
    conclusion: 'conditional conclusion',
  });
  assert.equal(result.specialist_id, 'polymer-1');
  assert.equal(result.claims.length, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.uncertainty.length, 1);
  assert.equal(result.epistemic_status, 'MIXED');
});

test('rejects specialist results without identity or conclusion', () => {
  assert.throws(() => createSpecialistResult({ capability: 'polymer' }), /specialist_id/);
  assert.throws(() => createSpecialistResult({ specialist_id: 'x', capability: 'polymer' }), /conclusion/);
});
