function lineageKey(claim) {
  return claim.lineage_id
    ? `lineage:${claim.lineage_id}`
    : `source:${claim.source_id ?? 'unknown'}`;
}

function summarizeClaims(claims) {
  const groups = new Map();

  for (const claim of claims) {
    if (!claim || claim.value === undefined) continue;
    if (!Number.isFinite(claim.evidence_score) || claim.evidence_score < 0 || claim.evidence_score > 1) {
      throw new TypeError('evidence_score must be between 0 and 1');
    }

    const key = String(claim.value);
    if (!groups.has(key)) groups.set(key, { value: claim.value, evidence: new Map() });

    const group = groups.get(key);
    const lineage = lineageKey(claim);
    const existing = group.evidence.get(lineage);
    if (!existing || claim.evidence_score > existing.score) {
      group.evidence.set(lineage, {
        score: claim.evidence_score,
        source_id: claim.source_id ?? null,
      });
    }
  }

  return [...groups.values()].map(group => {
    const scores = [...group.evidence.values()].map(item => item.score);
    const best = Math.max(...scores, 0);
    const mean = scores.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : 0;

    return {
      value: group.value,
      independent_sources: scores.length,
      best_score: best,
      mean_score: Number(mean.toFixed(6)),
    };
  });
}

export function resolveContradiction(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!Array.isArray(input.claims) || input.claims.length < 2) {
    throw new TypeError('at least two claims are required');
  }

  const candidates = summarizeClaims(input.claims)
    .sort((a, b) => (b.best_score - a.best_score) || (b.mean_score - a.mean_score));

  if (candidates.length < 2) {
    return {
      status: 'AGREED',
      preferred_value: candidates[0]?.value ?? null,
      contradiction_preserved: false,
      candidates,
    };
  }

  const [top, second] = candidates;
  const margin = top.best_score - second.best_score;

  if (margin < 0.05) {
    return {
      status: 'UNRESOLVED',
      preferred_value: null,
      contradiction_preserved: true,
      candidates,
    };
  }

  return {
    status: 'TENTATIVELY_RESOLVED',
    preferred_value: top.value,
    contradiction_preserved: true,
    candidates,
    reason: 'stronger independent evidence leads provisionally, but contrary evidence remains recorded',
  };
}
