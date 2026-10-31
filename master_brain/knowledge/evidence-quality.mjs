const SOURCE_BASE = {
  supplier_document: 0.9,
  scientific_paper: 0.95,
  patent: 0.8,
  official_document: 0.95,
  experiment: 1,
  web: 0.6,
  social_post: 0.35,
};

const DIRECTNESS = { DIRECT: 1, PARTIAL: 0.75, INDIRECT: 0.5, UNKNOWN: 0.35 };
const METHODOLOGY = { DOCUMENTED: 1, PARTIAL: 0.75, UNKNOWN: 0.45 };

export function scoreEvidence(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');

  const base = SOURCE_BASE[input.source_type] ?? 0.4;
  const directness = DIRECTNESS[input.directness] ?? DIRECTNESS.UNKNOWN;
  const methodology = METHODOLOGY[input.methodology] ?? METHODOLOGY.UNKNOWN;
  const independence = input.lineage_independent === true ? 1 : 0.35;
  const freshnessDays = Number.isFinite(input.freshness_days) && input.freshness_days >= 0
    ? input.freshness_days
    : 365;

  const freshness = freshnessDays <= 30 ? 1
    : freshnessDays <= 180 ? 0.9
    : freshnessDays <= 365 ? 0.75
    : freshnessDays <= 730 ? 0.55
    : 0.2;

  const rawScore = base * 0.3 + directness * 0.25 + methodology * 0.2 + independence * 0.15 + freshness * 0.1;
  const stalePenalty = freshnessDays > 730 ? 0.65 : 1;
  const score = Number((rawScore * stalePenalty).toFixed(6));

  let status = 'WEAK';
  if (freshnessDays > 730) status = 'STALE';
  else if (score >= 0.75) status = 'USABLE';
  else if (score >= 0.5) status = 'LIMITED';

  return { score, status, factors: { base, directness, methodology, independence, freshness, stalePenalty } };
}
