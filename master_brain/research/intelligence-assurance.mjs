const RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE',
});

const SOURCE_DEFAULTS = Object.freeze({
  SEARCH_WEB: 0.65, OFFICIAL_WEB: 0.85, NEWS: 0.7, SOCIAL: 0.45, VIDEO: 0.6,
  TV: 0.65, RADIO: 0.6, PODCAST: 0.55, FORUM: 0.45, ACADEMIC: 0.9,
  PATENT: 0.85, GOVERNMENT: 0.92, MARKET: 0.9, INDUSTRY: 0.72,
  DEEP_WEB: 0.35, DARK_WEB: 0.3, INTERNAL: 0.9,
});

const SOURCE_ROLE_MAP = Object.freeze({ official: 'GOVERNMENT', primary: 'GOVERNMENT', current: 'SEARCH_WEB' });
function clamp(n) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }

export function assessSourceReliability({ source_type, provenance = 'UNKNOWN', historical_reliability = 0.5, collection_quality = 0.5, independence = 0.5 } = {}) {
  if (!SOURCE_DEFAULTS[source_type]) return { status: RESULT.INCONCLUSIVE, reason: 'unknown source type', score: 0 };
  const base = SOURCE_DEFAULTS[source_type];
  const provenanceFactor = provenance === 'VERIFIED' ? 1 : provenance === 'UNKNOWN' ? 0.45 : 0;
  const score = clamp(0.4 * base + 0.25 * clamp(historical_reliability) + 0.2 * clamp(collection_quality) + 0.15 * clamp(independence));
  if (provenance === 'SPOOFED' || provenance === 'CORRUPTED') return { status: RESULT.FAIL, reason: 'source provenance is compromised', score: 0 };
  return { status: provenance === 'VERIFIED' ? RESULT.PASS : RESULT.INCONCLUSIVE, score: clamp(score * provenanceFactor) };
}

export function assessFreshness({ collected_at, now, half_life_hours = 24 } = {}) {
  const collected = Date.parse(collected_at), current = Date.parse(now);
  if (!Number.isFinite(collected) || !Number.isFinite(current) || half_life_hours <= 0) return { status: RESULT.INCONCLUSIVE, reason: 'invalid freshness inputs' };
  const ageHours = Math.max(0, (current - collected) / 36e5);
  const weight = Math.exp(-Math.log(2) * ageHours / half_life_hours);
  return { status: weight >= 0.25 ? 'FRESH' : 'STALE', age_hours: ageHours, weight };
}

export function buildLineageGraph({ claims = [] } = {}) {
  const byClaim = new Map(claims.map(c => [c.claim_id, c]));
  const independent_lineages_for_claim = (claimId) => {
    const root = byClaim.get(claimId); if (!root) return 0;
    return new Set(claims.map(c => c.lineage_id).filter(Boolean)).size;
  };
  const duplicated_lineages_for_claim = (claimId) => {
    const root = byClaim.get(claimId); if (!root) return 0;
    return claims.filter(c => c.lineage_id === root.lineage_id).length > 1 ? 1 : 0;
  };
  return { independent_lineages_for_claim, duplicated_lineages_for_claim };
}

export function detectClaimContradictions({ claims = [] } = {}) {
  const conflicts = [], byTopic = new Map();
  for (const claim of claims) {
    if (claim?.evidence_status !== 'VERIFIED') continue;
    const list = byTopic.get(claim.topic) ?? []; list.push(claim); byTopic.set(claim.topic, list);
  }
  for (const [topic, list] of byTopic) {
    const values = [...new Set(list.map(c => JSON.stringify(c.value)))];
    if (values.length > 1) conflicts.push({ topic, claim_ids: list.map(c => c.claim_id), values });
  }
  return conflicts.length ? { status: 'CONFLICTED', conflicts } : { status: RESULT.PASS, conflicts: [] };
}

export function fuseEvidence({ claims = [] } = {}) {
  if (!claims.length) return { status: RESULT.INCONCLUSIVE, reason: 'no evidence' };
  if (claims.some(c => c.provenance !== 'VERIFIED')) return { status: RESULT.INCONCLUSIVE, reason: 'provenance is not independently verified' };
  const contradiction = detectClaimContradictions({ claims });
  if (contradiction.status === 'CONFLICTED') return contradiction;
  const lineages = new Set(claims.map(c => c.lineage_id).filter(Boolean));
  const confidence = clamp(claims.reduce((s, c) => s + clamp(c.confidence), 0) / claims.length);
  if (!lineages.size) return { status: RESULT.INCONCLUSIVE, reason: 'lineage evidence is missing' };
  return { status: lineages.size >= 2 ? 'CORROBORATED' : 'SINGLE_SOURCE', confidence, independent_lineages: lineages.size };
}

export function expandSources({ selected = [], objective = '', uncertainty = 'LOW', missing_roles = [] } = {}) {
  const added = [];
  for (const role of missing_roles) {
    const source = SOURCE_ROLE_MAP[role];
    if (source && !selected.includes(source) && !added.includes(source)) added.push(source);
  }
  if (uncertainty === 'HIGH' && !added.includes('OFFICIAL_WEB') && !selected.includes('OFFICIAL_WEB')) added.push('OFFICIAL_WEB');
  return {
    added,
    expansion_reason: 'expanded source set for uncertainty=' + uncertainty + ', missing_roles=' + missing_roles.join(','),
    objective,
  };
}

export function evaluateIntelligenceCampaign({ observations = [], requested_action = 'ANALYZE' } = {}) {
  const reasons = [];
  if (requested_action !== 'ANALYZE') return { status: 'HOLD', reasons: ['campaign is limited to intelligence analysis'] };
  for (const o of observations) {
    if (o.provenance === 'SPOOFED' || o.provenance === 'CORRUPTED') reasons.push('poisoned or compromised provenance');
    if (o.stale === true) reasons.push('stale evidence');
    if (o.confidence === 'LOW') reasons.push('low-confidence evidence');
    if (o.sanitized !== true) reasons.push('unsanitized external content');
  }
  if (observations.some(o => o.source === 'DARK_WEB' && o.content_type === 'INSTRUCTION')) reasons.push('dark-web content attempted to become control authority');
  return reasons.length ? { status: 'HOLD', reasons: [...new Set(reasons)] } : { status: RESULT.PASS, reasons: [] };
}

export { RESULT, SOURCE_DEFAULTS };
