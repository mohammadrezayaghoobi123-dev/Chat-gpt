const STATUSES = new Set(['FACT', 'EVIDENCE', 'INFERENCE', 'HYPOTHESIS', 'UNCERTAIN']);

export function createSpecialistResult(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  for (const [field, value] of [['specialist_id', input.specialist_id], ['capability', input.capability], ['conclusion', input.conclusion]]) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(field + ' is required');
  }
  if (!Array.isArray(input.claims)) throw new TypeError('claims must be an array');
  if (!Array.isArray(input.evidence)) throw new TypeError('evidence must be an array');
  if (!Array.isArray(input.uncertainty)) throw new TypeError('uncertainty must be an array');

  const claims = input.claims.map(claim => {
    if (!claim || typeof claim.id !== 'string' || !claim.id.trim()) throw new TypeError('claim id is required');
    if (typeof claim.statement !== 'string' || !claim.statement.trim()) throw new TypeError('claim statement is required');
    const status = claim.status ?? 'UNCERTAIN';
    if (!STATUSES.has(status)) throw new TypeError('invalid claim epistemic status');
    return { ...claim, id: claim.id.trim(), statement: claim.statement.trim(), status };
  });

  const epistemic = new Set(claims.map(claim => claim.status));
  const epistemic_status = input.uncertainty.length > 0
    ? 'MIXED'
    : epistemic.size === 0
      ? 'UNCERTAIN'
      : epistemic.size === 1
        ? [...epistemic][0]
        : 'MIXED';

  return {
    type: 'SpecialistResult',
    specialist_id: input.specialist_id.trim(),
    capability: input.capability.trim(),
    model_id: input.model_id ?? null,
    claims,
    evidence: structuredClone(input.evidence),
    uncertainty: structuredClone(input.uncertainty),
    conclusion: input.conclusion.trim(),
    epistemic_status,
  };
}
