export function assessFalsification(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (typeof input.hypothesis !== 'string' || !input.hypothesis.trim()) throw new TypeError('hypothesis is required');
  const prediction = typeof input.prediction === 'string' ? input.prediction.trim() : '';
  const test = typeof input.test === 'string' ? input.test.trim() : '';
  const criteria = Array.isArray(input.falsification_criteria) ? input.falsification_criteria.filter(Boolean) : [];
  const status = prediction && test && criteria.length ? 'TESTABLE' : 'INCOMPLETE';
  return { hypothesis: input.hypothesis.trim(), prediction: prediction || undefined, test: test || undefined, falsification_criteria: criteria, status };
}