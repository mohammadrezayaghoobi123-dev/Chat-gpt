import { resolveDomain } from '../routing/domain-graph.mjs';
import { assessEvidenceRequirement } from '../knowledge/evidence-requirement-engine.mjs';

export function buildGovernanceContext(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const domain = resolveDomain(input.graph, input.domain_id);
  const risk = input.risk;
  const decisionImpact = input.decision_impact;

  const evidence = assessEvidenceRequirement({
    evidence_requirement: domain.evidence_requirement,
    criticality: domain.criticality,
    risk: risk?.level,
    decision_impact: decisionImpact,
  });

  return {
    domain,
    risk,
    evidence,
    governance: {
      human_approval: domain.human_oversight === 'HUMAN_APPROVAL' || evidence.human_approval,
      specialist_review: domain.human_oversight !== 'NONE' || evidence.specialist_review,
    },
  };
}
