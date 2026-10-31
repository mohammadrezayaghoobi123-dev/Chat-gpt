const EPISTEMIC_KINDS = new Set([
  'FACT',
  'OBSERVATION',
  'CALCULATION',
  'INFERENCE',
  'HYPOTHESIS',
  'ASSUMPTION',
  'ESTIMATE',
  'PREDICTION',
  'OPINION',
  'UNKNOWN',
]);

export function createEpistemicRecord(input = {}) {
  if (typeof input.statement !== 'string' || !input.statement.trim()) {
    throw new TypeError('statement is required');
  }

  const kind = input.kind ?? 'UNKNOWN';
  if (!EPISTEMIC_KINDS.has(kind)) {
    throw new TypeError(`invalid epistemic kind: ${kind}`);
  }

  return {
    type: 'EpistemicRecord',
    statement: input.statement.trim(),
    kind,
    basis: [...(input.basis ?? [])],
  };
}

export function listEpistemicKinds() {
  return [...EPISTEMIC_KINDS];
}
