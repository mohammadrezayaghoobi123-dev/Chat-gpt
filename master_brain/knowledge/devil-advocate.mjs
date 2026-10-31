function groupClaims(results) {
  const groups = new Map();
  for (const result of results) {
    if (!result || !Array.isArray(result.claims)) continue;
    for (const claim of result.claims) {
      if (!claim || claim.subject === undefined || claim.predicate === undefined || claim.value === undefined) continue;
      const key = JSON.stringify([claim.subject, claim.predicate]);
      if (!groups.has(key)) groups.set(key, new Map());
      const values = groups.get(key);
      if (!values.has(claim.value)) values.set(claim.value, { supporting_results: 0, source_ids: new Set(), lineages: new Set() });
      const bucket = values.get(claim.value);
      bucket.supporting_results += 1;
      if (claim.source_id !== undefined && claim.source_id !== null) bucket.source_ids.add(claim.source_id);
      bucket.lineages.add(claim.lineage_id ? `lineage:${claim.lineage_id}` : `source:${claim.source_id ?? 'unknown'}`);
    }
  }
  return groups;
}

export function devilAdvocate(results = []) {
  if (!Array.isArray(results)) throw new TypeError('results must be an array');
  return [...groupClaims(results).entries()].map(([key, values]) => {
    const [subject, predicate] = JSON.parse(key);
    const buckets = [...values.entries()].map(([value, data]) => ({
      value,
      supporting_results: data.supporting_results,
      independent_sources: data.lineages.size,
    })).sort((a, b) => b.independent_sources - a.independent_sources || b.supporting_results - a.supporting_results);
    const leading = buckets[0];
    const challenge = buckets.find(bucket => bucket.value !== leading.value);
    return { subject, predicate, leading_value: leading.value, leading_supporting_results: leading.supporting_results, challenge: challenge ? { status: 'CHALLENGED', value: challenge.value, supporting_results: challenge.supporting_results, independent_sources: challenge.independent_sources } : { status: 'UNCHALLENGED' } };
  });
}

function questionSet(claim) {
  return [
    `definition: Is "${claim.predicate}" defined identically across all sources?`,
    'operating: Were operating conditions, configuration, and measurement method comparable?',
    'time: Could differences in date, model revision, or market conditions explain the conflict?',
    'incentive: Does any source have a commercial incentive that could bias the claim?',
    'measurement: Is the reported value measured, documented, estimated, or merely repeated?',
  ];
}

export function challengeDecision(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!input.claim || typeof input.claim !== 'object') throw new TypeError('claim is required');
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw new TypeError('evidence is required');
  if (!Array.isArray(input.alternatives)) throw new TypeError('alternatives are required');

  const scores = input.evidence.map(item => {
    const direct = item.directness === 'DIRECT' ? 1 : item.directness === 'PARTIAL' ? 0.75 : 0.5;
    const method = item.methodology === 'DOCUMENTED' ? 1 : item.methodology === 'PARTIAL' ? 0.75 : 0.45;
    const independent = item.lineage_independent === true ? 1 : 0.35;
    const fresh = item.freshness_days <= 30 ? 1 : item.freshness_days <= 365 ? 0.75 : 0.4;
    const type = item.source_type === 'scientific_paper' ? 0.95 : item.source_type === 'official_document' ? 0.95 : item.source_type === 'supplier_document' ? 0.9 : item.source_type === 'experiment' ? 1 : item.source_type === 'social_post' ? 0.35 : 0.5;
    return type * 0.3 + direct * 0.25 + method * 0.2 + independent * 0.15 + fresh * 0.1;
  });

  const alternativeMax = input.alternatives.reduce((max, item) => Math.max(max, Number(item.evidence_score) || 0), 0);
  const leading = Math.max(...scores, 0);
  const margin = leading - alternativeMax;
  const comparableIndependentEvidence = input.evidence.length >= 2 && input.evidence.every(item => item.lineage_independent === true);
  const unresolved = margin < 0.05 || (comparableIndependentEvidence && alternativeMax >= 0.85 && margin < 0.12) || leading < 0.6;

  return {
    status: unresolved ? 'UNRESOLVED' : 'CHALLENGE_REQUIRED',
    decision_safe: !unresolved,
    leading_score: Number(leading.toFixed(6)),
    alternative_score: alternativeMax,
    questions: questionSet(input.claim),
    reconsideration_triggers: [
      'new independent evidence materially changes the evidence margin',
      'operating definition or measurement method is shown to differ',
      'a primary source contradicts the current leading claim',
      'a relevant model revision or date change invalidates the comparison',
    ],
  };
}
