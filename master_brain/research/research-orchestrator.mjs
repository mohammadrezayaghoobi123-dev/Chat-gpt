const SOURCE_PROFILES = {
  web: { role: 'current_market_and_broad_discovery', needs: ['current_market', 'supplier_evidence', 'general_research'] },
  youtube: { role: 'visual_process_and_field_signal', needs: ['current_market', 'supplier_evidence', 'process_observation'] },
  paper: { role: 'scientific_primary_evidence', needs: ['scientific_fact', 'mechanism', 'experimental_evidence'] },
  patent: { role: 'prior_art_and_technical_landscape', needs: ['patent_landscape', 'technical_landscape'] },
  reddit: { role: 'user_experience_signal', needs: ['user_experience', 'market_signal'] },
  linkedin: { role: 'professional_and_company_signal', needs: ['supplier_evidence', 'company_signal'] },
  instagram: { role: 'market_and_product_signal', needs: ['market_signal', 'product_signal'] },
  telegram: { role: 'market_signal', needs: ['market_signal'] },
};

const PRIORITY = ['paper', 'patent', 'web', 'youtube', 'linkedin', 'reddit', 'instagram', 'telegram'];

function hasNeed(needs, profile) {
  return needs.some(need => profile.needs.includes(need));
}

export function selectResearchSources(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (typeof input.objective !== 'string' || !input.objective.trim()) throw new TypeError('objective is required');

  const needs = Array.isArray(input.needs) ? input.needs : [];
  if (!needs.length) throw new TypeError('needs are required');

  if (input.authoritative_sources_available === true && needs.includes('scientific_fact')) {
    return {
      selected: ['paper'],
      rejected: PRIORITY.filter(source => source !== 'paper'),
      reason: 'authoritative scientific evidence is sufficient for the stated fact',
    };
  }

  const selected = PRIORITY.filter(source => hasNeed(needs, SOURCE_PROFILES[source]));
  if (!selected.includes('web') && needs.includes('current_market')) selected.unshift('web');

  return {
    selected,
    rejected: PRIORITY.filter(source => !selected.includes(source)),
    reason: 'selected by evidence role and task need',
  };
}

export function createResearchPlan(input = {}) {
  const selection = selectResearchSources(input);
  const steps = selection.selected.map((source, index) => ({
    step: index + 1,
    source,
    role: SOURCE_PROFILES[source].role,
    status: 'READY',
  }));

  return {
    status: 'PLANNED',
    objective: input.objective.trim(),
    domain: input.domain ?? null,
    steps,
    verification: [
      'source_independence',
      'contradiction_check',
      'evidence_quality',
      'claim_verification',
    ],
  };
}
