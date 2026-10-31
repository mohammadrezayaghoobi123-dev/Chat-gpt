import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainGraph } from '../../master_brain/routing/domain-graph.mjs';
import { buildGovernanceContext } from '../../master_brain/core/governance-context.mjs';

test('combines domain policy with evidence requirements and risk without lowering the domain floor', () => {
  const graph = createDomainGraph([{
    domain_id: 'nuclear',
    name: 'Nuclear',
    capabilities: ['nuclear-safety'],
    evidence_requirement: 'CRITICAL',
    criticality: 'C4',
    human_oversight: 'HUMAN_APPROVAL',
  }]);

  const context = buildGovernanceContext({
    graph,
    domain_id: 'nuclear',
    risk: { level: 'LOW', reversibility: 'REVERSIBLE' },
    decision_impact: 'LOW',
  });

  assert.equal(context.domain.criticality, 'C4');
  assert.equal(context.evidence.evidence_level, 'CRITICAL');
  assert.equal(context.evidence.min_independent_sources, 3);
  assert.equal(context.governance.human_approval, true);
});

test('preserves medium domain requirements while raising them for high decision risk', () => {
  const graph = createDomainGraph([{
    domain_id: 'business',
    name: 'Business',
    capabilities: ['strategy'],
    evidence_requirement: 'MEDIUM',
    criticality: 'C1',
    human_oversight: 'REVIEW',
  }]);

  const context = buildGovernanceContext({
    graph,
    domain_id: 'business',
    risk: { level: 'HIGH', reversibility: 'DIFFICULT' },
    decision_impact: 'HIGH',
  });

  assert.equal(context.evidence.evidence_level, 'HIGH');
  assert.equal(context.evidence.min_independent_sources, 2);
  assert.equal(context.governance.human_approval, false);
});

test('fails closed when the domain is unknown', () => {
  const graph = createDomainGraph([]);
  assert.throws(() => buildGovernanceContext({
    graph,
    domain_id: 'unknown',
    risk: { level: 'LOW', reversibility: 'REVERSIBLE' },
    decision_impact: 'LOW',
  }), /domain not found/);
});
