import { createDomainProfile } from './domain-registry.mjs';

export function createDomainGraph(profiles = []) {
  if (!Array.isArray(profiles)) throw new TypeError('profiles must be an array');
  const nodes = {};
  const children = {};

  for (const input of profiles) {
    const profile = createDomainProfile(input);
    if (nodes[profile.domain_id]) throw new Error('duplicate domain_id');
    nodes[profile.domain_id] = profile;
    children[profile.domain_id] ??= [];
  }

  for (const profile of Object.values(nodes)) {
    if (profile.parent_domain !== null) {
      if (!nodes[profile.parent_domain]) throw new Error('unknown parent_domain');
      children[profile.parent_domain].push(profile.domain_id);
    }
  }

  for (const key of Object.keys(children)) children[key].sort();
  return { nodes, children };
}

export function resolveDomain(graph, domainId) {
  if (!graph || typeof graph !== 'object' || !graph.nodes) throw new TypeError('graph is required');
  if (typeof domainId !== 'string' || !domainId.trim()) throw new TypeError('domainId is required');
  const node = graph.nodes[domainId.trim()];
  if (!node) throw new Error('domain not found');
  return node;
}
