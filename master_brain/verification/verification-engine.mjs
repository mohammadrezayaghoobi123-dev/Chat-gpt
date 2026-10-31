const FAILURES = [
  ['evidence', input => input.evidence?.status !== 'VERIFIED', 'evidence is not verified'],
  ['assumption', input => (input.assumptions?.high_impact_unverified ?? 0) > 0, 'high-impact assumptions remain unverified'],
  ['contradiction', input => (input.contradictions?.unresolved ?? 0) > 0, 'unresolved contradictions remain'],
  ['calculation', input => input.calculations?.status !== 'VALID', 'calculations are not validated'],
];

export function verifyAnalysis(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const reasons = FAILURES.filter(([, failed]) => failed(input)).map(([, , reason]) => reason);
  return { status: reasons.length ? 'BLOCKED' : 'VERIFIED', reasons };
}