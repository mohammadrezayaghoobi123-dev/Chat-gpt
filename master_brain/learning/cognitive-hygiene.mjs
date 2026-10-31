const SAFE_TRANSIENT_KINDS = new Set(['transient', 'ephemeral', 'scratch']);

export function assessCognitiveHygiene(items = []) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');

  const results = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      results.push({ item, action: 'KEEP', reason: 'INVALID_FOR_DELETION' });
      continue;
    }

    if (item.status === 'CONFLICTED') {
      results.push({ item, action: 'QUARANTINE', reason: 'UNRESOLVED_CONTRADICTION' });
      continue;
    }

    if (SAFE_TRANSIENT_KINDS.has(item.kind)) {
      results.push({ item, action: 'PRUNE', reason: 'SAFE_TRANSIENT_NOISE' });
      continue;
    }

    if (item.status === 'VERIFIED') {
      results.push({ item, action: 'KEEP', reason: 'VERIFIED_KNOWLEDGE' });
      continue;
    }

    if (item.status === 'UNVERIFIED' &&
        item.source_quality?.score < 0.5 &&
        item.uncertainty > 0.8) {
      results.push({ item, action: 'QUARANTINE', reason: 'LOW_EVIDENCE_HIGH_UNCERTAINTY' });
      continue;
    }

    if (typeof item.utility_score === 'number' && item.utility_score < 0.1) {
      results.push({ item, action: 'REVIEW', reason: 'LOW_UTILITY_UNVERIFIED' });
      continue;
    }

    results.push({ item, action: 'KEEP', reason: 'INSUFFICIENT_BASIS_FOR_PRUNING' });
  }

  return { items: results };
}
