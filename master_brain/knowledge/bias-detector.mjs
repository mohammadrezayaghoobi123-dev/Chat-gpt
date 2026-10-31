const BIASES = {
  confirmation: 'CONFIRMATION_BIAS', anchoring: 'ANCHORING_BIAS', availability: 'AVAILABILITY_BIAS',
  selection: 'SELECTION_BIAS', survivorship: 'SURVIVORSHIP_BIAS', recency: 'RECENCY_BIAS',
  authority: 'AUTHORITY_BIAS', base_rate: 'BASE_RATE_NEGLECT', motivated_reasoning: 'MOTIVATED_REASONING', groupthink: 'GROUPTHINK',
};
const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);
export function detectBiases(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const indicators = input.indicators ?? {};
  if (!indicators || typeof indicators !== 'object') throw new TypeError('indicators must be an object');
  const severity = input.severity ?? {};
  if (!severity || typeof severity !== 'object') throw new TypeError('severity must be an object');
  const detected = [];
  for (const [key, bias] of Object.entries(BIASES)) {
    if (indicators[key] !== true) continue;
    const level = severity[key] ?? 'MEDIUM';
    if (!SEVERITIES.has(level)) throw new TypeError('invalid bias severity: ' + key);
    detected.push({ bias, severity: level });
  }
  return { detected, count: detected.length };
}
export function listBiases() { return Object.values(BIASES); }