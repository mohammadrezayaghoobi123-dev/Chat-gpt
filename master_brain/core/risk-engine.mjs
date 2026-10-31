const IMPACTS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const REVERSIBILITY = new Set(['REVERSIBLE', 'DIFFICULT', 'IRREVERSIBLE']);

export function assessRisk(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!IMPACTS.has(input.impact)) throw new TypeError('invalid impact');
  if (typeof input.probability !== 'number' || input.probability < 0 || input.probability > 1) throw new TypeError('invalid probability');
  if (!REVERSIBILITY.has(input.reversibility)) throw new TypeError('invalid reversibility');
  if (input.impact === 'CRITICAL' || input.reversibility === 'IRREVERSIBLE') return { level: 'CRITICAL' };
  if (input.impact === 'HIGH' || input.probability >= 0.5 || input.reversibility === 'DIFFICULT') return { level: 'HIGH' };
  if (input.impact === 'MEDIUM' || input.probability >= 0.2) return { level: 'MEDIUM' };
  return { level: 'LOW' };
}