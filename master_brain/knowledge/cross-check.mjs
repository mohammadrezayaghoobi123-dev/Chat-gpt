function key(claim) {
  return JSON.stringify([claim.subject, claim.predicate]);
}

function independentKey(claim) {
  return claim.lineage_id
    ? `lineage:${claim.lineage_id}`
    : `source:${claim.source_id ?? 'unknown'}`;
}

function addMetadata(bucket, claim, result) {
  if (claim.source_id !== undefined && claim.source_id !== null) bucket.source_ids.add(claim.source_id);
  bucket.independent_keys.add(independentKey(claim));
  if (claim.lineage_id) bucket.lineage_ids.add(claim.lineage_id);
  if (result.model_id) bucket.model_ids.add(result.model_id);
  if (Array.isArray(claim.uncertainty)) {
    for (const item of claim.uncertainty) bucket.uncertainties.add(item);
  }
}

function finalizeBucket(data) {
  return {
    supporting_results: data.supporting_results,
    independent_sources: data.independent_keys.size,
    source_ids: [...data.source_ids],
    lineage_ids: [...data.lineage_ids],
    model_ids: [...data.model_ids],
    uncertainties: [...data.uncertainties],
  };
}

export function crossCheck(results = []) {
  if (!Array.isArray(results)) throw new TypeError('results must be an array');

  const groups = new Map();

  for (const result of results) {
    if (!result || !Array.isArray(result.claims)) continue;
    for (const claim of result.claims) {
      if (!claim || claim.subject === undefined || claim.predicate === undefined || claim.value === undefined) continue;
      const groupKey = key(claim);
      if (!groups.has(groupKey)) groups.set(groupKey, new Map());
      const values = groups.get(groupKey);

      if (!values.has(claim.value)) {
        values.set(claim.value, {
          supporting_results: 0,
          source_ids: new Set(),
          independent_keys: new Set(),
          lineage_ids: new Set(),
          model_ids: new Set(),
          uncertainties: new Set(),
        });
      }

      const bucket = values.get(claim.value);
      bucket.supporting_results += 1;
      addMetadata(bucket, claim, result);
    }
  }

  return [...groups.entries()].map(([groupKey, values]) => {
    const [subject, predicate] = JSON.parse(groupKey);
    const buckets = [...values.entries()].map(([value, data]) => ({
      value,
      ...finalizeBucket(data),
    }));

    const top = [...buckets].sort((a, b) => {
      if (b.independent_sources !== a.independent_sources) return b.independent_sources - a.independent_sources;
      return b.supporting_results - a.supporting_results;
    })[0];

    return {
      subject,
      predicate,
      status: buckets.length === 1 ? 'AGREED' : 'CONFLICTED',
      values: buckets.map(bucket => bucket.value),
      agreement: top,
      contradiction: buckets.length > 1
        ? buckets.find(bucket => bucket.value !== top.value)
        : undefined,
    };
  });
}
