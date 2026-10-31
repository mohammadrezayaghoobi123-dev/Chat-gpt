const STATUSES = new Set(['CAUSAL_SUPPORTED', 'CORRELATIONAL_ONLY', 'INSUFFICIENT']);

export function assessCausalClaim(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (typeof input.cause !== 'string' || !input.cause.trim()) throw new TypeError('cause is required');
  if (typeof input.effect !== 'string' || !input.effect.trim()) throw new TypeError('effect is required');

  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const mechanism = typeof input.mechanism === 'string' && input.mechanism.trim();
  const alternatives = Array.isArray(input.alternative_explanations) ? input.alternative_explanations : [];
  const counterfactual = typeof input.counterfactual === 'string' && input.counterfactual.trim();

  if (evidence.length === 1 && evidence[0] === 'correlation') {
    return { cause: input.cause.trim(), effect: input.effect.trim(), status: 'CORRELATIONAL_ONLY' };
  }

  const supported = Boolean(mechanism && counterfactual && alternatives.length === 0 && evidence.length > 0);
  return {
    cause: input.cause.trim(),
    effect: input.effect.trim(),
    status: supported ? 'CAUSAL_SUPPORTED' : 'INSUFFICIENT',
    evidence,
    mechanism: mechanism || undefined,
    alternative_explanations: alternatives,
    counterfactual: counterfactual || undefined,
  };
}

export function listCausalStatuses() {
  return [...STATUSES];
}
