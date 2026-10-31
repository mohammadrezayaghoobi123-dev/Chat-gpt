const PLATFORMS = new Set(['web', 'youtube', 'instagram', 'linkedin', 'telegram', 'reddit', 'news', 'paper', 'patent', 'file']);

export function normalizeSourceRecord(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!PLATFORMS.has(input.platform)) throw new TypeError('platform is required');
  if (typeof input.source_id !== 'string' || !input.source_id.trim()) throw new TypeError('source_id is required');

  const source_id = input.source_id.trim();
  const lineage_id = input.lineage_id ?? null;
  const lineage_type = input.lineage_type ?? 'UNKNOWN';
  const claims = Array.isArray(input.claims)
    ? input.claims.map(claim => ({ ...claim, status: claim.status ?? 'UNVERIFIED' }))
    : [];

  return {
    ...input,
    platform: input.platform,
    source_id,
    provenance: {
      platform: input.platform,
      source_id,
      source_url: input.source_url ?? null,
      retrieved_at: input.retrieved_at ?? null,
      lineage_id,
      lineage_type,
    },
    independence: {
      key: lineage_id ? `lineage:${lineage_id}` : `${input.platform}:${source_id}`,
    },
    claims,
  };
}

export function assessSourceIndependence(sources = []) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');

  const independent = new Set();
  const lineages = new Set();

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const key = source.lineage_id
      ? `lineage:${source.lineage_id}`
      : `source:${source.platform ?? 'unknown'}:${source.source_id ?? 'unknown'}`;
    independent.add(key);
    if (source.lineage_id) lineages.add(source.lineage_id);
  }

  return {
    independent_sources: independent.size,
    lineages: [...lineages],
  };
}
