function claimKey(claim) {
  return JSON.stringify([claim.subject, claim.predicate, claim.value]);
}

export function aggregateEvidence(results = []) {
  if (!Array.isArray(results)) throw new TypeError('results must be an array');

  const groups = new Map();

  for (const result of results) {
    if (!result || !Array.isArray(result.claims)) continue;
    for (const claim of result.claims) {
      if (!claim || claim.subject === undefined || claim.predicate === undefined || claim.value === undefined) continue;
      const key = claimKey(claim);
      if (!groups.has(key)) {
        groups.set(key, {
          subject: claim.subject,
          predicate: claim.predicate,
          value: claim.value,
          supporting_results: 0,
          source_ids: new Set(),
          lineage_ids: new Set(),
          independent_keys: new Set(),
        });
      }
      const group = groups.get(key);
      group.supporting_results += 1;
      if (claim.source_id !== undefined && claim.source_id !== null) group.source_ids.add(claim.source_id);

      const independentKey = claim.lineage_id
        ? `lineage:${claim.lineage_id}`
        : `source:${claim.source_id ?? 'unknown'}`;
      group.independent_keys.add(independentKey);
      if (claim.lineage_id) group.lineage_ids.add(claim.lineage_id);
    }
  }

  return {
    claims: [...groups.values()].map(group => ({
      ...group,
      source_ids: [...group.source_ids],
      lineage_ids: [...group.lineage_ids],
      independent_sources: group.independent_keys.size,
      independent_keys: undefined,
    })),
  };
}
