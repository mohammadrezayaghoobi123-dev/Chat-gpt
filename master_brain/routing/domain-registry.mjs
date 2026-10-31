const CRITICALITIES = new Set(['C0', 'C1', 'C2', 'C3', 'C4']);
const EVIDENCE_REQUIREMENTS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const OVERSIGHT = new Set(['NONE', 'REVIEW', 'HUMAN_APPROVAL']);

function assertString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(name + ' is required');
}

export function validateDomainProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') throw new TypeError('profile is required');
  assertString(profile.domain_id, 'domain_id');
  assertString(profile.name, 'name');
  if (!CRITICALITIES.has(profile.criticality)) throw new TypeError('invalid criticality');
  if (!EVIDENCE_REQUIREMENTS.has(profile.evidence_requirement)) throw new TypeError('invalid evidence requirement');
  if (!OVERSIGHT.has(profile.human_oversight)) throw new TypeError('invalid human oversight');
  if (!Array.isArray(profile.capabilities)) throw new TypeError('capabilities must be an array');
  return true;
}

export function createDomainProfile(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const profile = {
    domain_id: input.domain_id?.trim(),
    name: input.name?.trim(),
    parent_domain: input.parent_domain?.trim() ?? null,
    capabilities: [...(input.capabilities ?? [])],
    evidence_requirement: input.evidence_requirement ?? 'MEDIUM',
    criticality: input.criticality ?? 'C0',
    human_oversight: input.human_oversight ?? 'NONE',
  };
  validateDomainProfile(profile);
  return profile;
}
