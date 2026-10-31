export function routeDomainTask(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (typeof input.objective !== 'string' || !input.objective.trim()) throw new TypeError('objective is required');
  if (!Array.isArray(input.required_capabilities) || input.required_capabilities.length === 0) {
    throw new TypeError('required_capabilities are required');
  }
  if (!Array.isArray(input.domain_candidates)) throw new TypeError('domain_candidates must be an array');

  const required = [...new Set(input.required_capabilities)];
  const eligible = input.domain_candidates.filter(domain =>
    domain && typeof domain.domain_id === 'string' &&
    Array.isArray(domain.capabilities) &&
    required.some(capability => domain.capabilities.includes(capability))
  );

  if (eligible.length === 0) throw new Error('no eligible domain');

  const selected = new Map();
  for (const domain of eligible) {
    for (const capability of required) {
      if (domain.capabilities.includes(capability)) selected.set(domain.domain_id, domain);
    }
  }

  const domains = [...selected.keys()].sort();
  const matchedCapabilities = required.filter(capability =>
    domains.some(domainId => selected.get(domainId).capabilities.includes(capability))
  );

  if (matchedCapabilities.length !== required.length) throw new Error('no eligible domain');

  return {
    objective: input.objective.trim(),
    domains,
    required_capabilities: matchedCapabilities,
    multi_domain: domains.length > 1,
  };
}
