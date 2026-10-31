const RISKS = new Set(['low','medium','high','critical']);
const PROVENANCE = new Set(['VERIFIED','UNKNOWN','UNVERIFIED']);
const AVAILABILITY = new Set(['ACTIVE','CANDIDATE','QUARANTINED','DISABLED']);
const HEALTH = new Set(['HEALTHY','DEGRADED','DOWN','UNKNOWN']);
const FRESHNESS = new Set(['FRESH','AGING','STALE','UNKNOWN']);
const INTEGRITY = new Set(['VERIFIED','UNVERIFIED','UNKNOWN']);

export function createModelProviderRegistry(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const keys = new Set();
  return entries.map(entry => {
    if (!entry?.provider_id || !entry?.model_id) throw new TypeError('provider_id and model_id are required');
    const key = entry.provider_id + ':' + entry.model_id;
    if (keys.has(key)) throw new TypeError(`duplicate model/provider: ${key}`);
    keys.add(key);
    if (!Array.isArray(entry.capabilities)) throw new TypeError('capabilities required');
    if (!Array.isArray(entry.risk_levels) || entry.risk_levels.some(x => !RISKS.has(x))) throw new TypeError('invalid risk_levels');
    if (typeof entry.reliability !== 'number' || entry.reliability < 0 || entry.reliability > 1) throw new TypeError('invalid reliability');
    if (entry.provenance && !PROVENANCE.has(entry.provenance)) throw new TypeError('invalid provenance');
    if (entry.availability && !AVAILABILITY.has(entry.availability)) throw new TypeError('invalid availability');
    if (entry.health && !HEALTH.has(entry.health)) throw new TypeError('invalid health');
    if (entry.freshness && !FRESHNESS.has(entry.freshness)) throw new TypeError('invalid freshness');
    if (entry.integrity && !INTEGRITY.has(entry.integrity)) throw new TypeError('invalid integrity');
    return {
      provenance:'VERIFIED',
      availability:'ACTIVE',
      health:'HEALTHY',
      freshness:'FRESH',
      integrity:'VERIFIED',
      independence_group: entry.independence_group ?? entry.provider_id,
      ...entry,
      capabilities:[...new Set(entry.capabilities)],
      risk_levels:[...new Set(entry.risk_levels)]
    };
  });
}

export function routeAcrossProviders(registry, task) {
  if (!Array.isArray(registry)) throw new TypeError('registry must be an array');
  const risk = task?.risk ?? 'medium';
  if (!RISKS.has(risk)) throw new TypeError('invalid risk');
  const required = new Set(task.required_capabilities ?? []);
  const min = Math.max(1, task.min_independent_providers ?? 1);
  const eligible = registry.filter(x =>
    x.availability === 'ACTIVE' &&
    x.provenance === 'VERIFIED' &&
    x.integrity === 'VERIFIED' &&
    x.freshness !== 'STALE' &&
    x.health !== 'DOWN' &&
    (risk === 'low' || x.health === 'HEALTHY') &&
    [...required].every(c => x.capabilities.includes(c))
  );
  const byProvider = new Map();
  for (const x of eligible) {
    const current = byProvider.get(x.provider_id);
    if (!current || x.reliability > current.reliability) byProvider.set(x.provider_id, x);
  }
  const providers = [...byProvider.values()].sort((a,b) =>
    (b.reliability ?? 0) - (a.reliability ?? 0) || (a.cost ?? 1) - (b.cost ?? 1)
  );
  const selected = [];
  const groups = new Set();
  for (const candidate of providers) {
    const group = candidate.independence_group ?? candidate.provider_id;
    if (groups.has(group)) continue;
    groups.add(group);
    selected.push(candidate);
    if (selected.length >= min) break;
  }
  return selected.length >= min
    ? {status:'READY', providers:selected}
    : {status:'HOLD', providers:selected, reason:'insufficient independent verified healthy providers'};
}
