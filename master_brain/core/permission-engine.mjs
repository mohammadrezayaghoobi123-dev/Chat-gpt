const LEVELS = { LOW: 'L1', MEDIUM: 'L2', HIGH: 'L2', CRITICAL: 'L3' };

export function authorize(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!LEVELS[input.risk]) throw new TypeError('invalid risk');
  if (input.risk === 'CRITICAL') return { level: 'L3', allowed: false, requires_approval: true };
  if (input.decision !== 'PROCEED') return { level: LEVELS[input.risk], allowed: false, requires_approval: false };
  return { level: LEVELS[input.risk], allowed: true, requires_approval: false };
}
