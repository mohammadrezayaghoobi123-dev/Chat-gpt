import test from 'node:test';
import assert from 'node:assert/strict';
import { selectResearchSources, createResearchPlan } from '../../master_brain/research/research-orchestrator.mjs';

test('selects sources by task value instead of calling every source', () => {
  const result = selectResearchSources({
    objective: 'Compare current EVA hot press machine manufacturers',
    domain: 'manufacturing',
    needs: ['current_market', 'supplier_evidence'],
  });

  assert.ok(result.selected.includes('web'));
  assert.ok(result.selected.includes('youtube'));
  assert.ok(!result.selected.includes('paper'));
  assert.ok(!result.selected.includes('instagram'));
  assert.ok(result.selected.length < 6);
});

test('does not select social sources when authoritative evidence is sufficient for a technical fact', () => {
  const result = selectResearchSources({
    objective: 'Verify a specific chemical property from scientific literature',
    domain: 'chemistry',
    needs: ['scientific_fact'],
    authoritative_sources_available: true,
  });

  assert.deepEqual(result.selected, ['paper']);
});

test('creates an auditable research plan with source roles and verification', () => {
  const plan = createResearchPlan({
    objective: 'Investigate an EVA machine supplier',
    domain: 'manufacturing',
    needs: ['supplier_evidence', 'current_market'],
  });

  assert.equal(plan.status, 'PLANNED');
  assert.ok(plan.steps.length >= 2);
  assert.ok(plan.steps.every(step => step.source && step.role));
  assert.ok(plan.verification.includes('source_independence'));
  assert.ok(plan.verification.includes('contradiction_check'));
});
