const REQUIREMENTS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const CRITICALITIES = new Set(['C0', 'C1', 'C2', 'C3', 'C4']);
const RISKS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const IMPACTS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export function assessEvidenceRequirement(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!REQUIREMENTS.has(input.evidence_requirement)) throw new TypeError('invalid evidence requirement');
  if (!CRITICALITIES.has(input.criticality)) throw new TypeError('invalid criticality');
  if (!RISKS.has(input.risk)) throw new TypeError('invalid risk');
  if (!IMPACTS.has(input.decision_impact)) throw new TypeError('invalid decision impact');

  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  const criticalityRank = Number(input.criticality.slice(1));
  const effective = Math.max(
    rank[input.evidence_requirement],
    rank[input.risk],
    rank[input.decision_impact],
    criticalityRank >= 4 ? 3 : criticalityRank >= 3 ? 2 : criticalityRank >= 1 ? 1 : 0,
  );

  return {
    evidence_level: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'][effective],
    min_independent_sources: effective >= 3 ? 3 : effective >= 1 ? 2 : 1,
    primary_source_required: effective >= 2,
    specialist_review: effective >= 2,
    devils_advocate: effective >= 2,
    quantitative_check: effective >= 2,
    human_approval: effective >= 3,
  };
}
