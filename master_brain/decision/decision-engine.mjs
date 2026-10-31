const IMPACTS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const REVERSIBILITY = new Set(['REVERSIBLE', 'DIFFICULT', 'IRREVERSIBLE']);

export function decide(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const prediction = input.prediction?.success_probability;
  if (typeof prediction !== 'number' || prediction < 0 || prediction > 1) throw new TypeError('success_probability must be between 0 and 1');
  const risk = input.risk ?? {};
  if (!IMPACTS.has(risk.impact)) throw new TypeError('invalid risk impact');
  if (typeof risk.probability !== 'number' || risk.probability < 0 || risk.probability > 1) throw new TypeError('invalid risk probability');
  if (!REVERSIBILITY.has(risk.reversibility)) throw new TypeError('invalid reversibility');
  const reasons = [];
  if (input.verification?.status !== 'VERIFIED') reasons.push('verification is not complete');
  if (input.stability?.status !== 'ROBUST') reasons.push('decision is not stable');
  if (input.value_of_information?.status === 'COLLECT_INFORMATION') reasons.push('additional information has positive value');
  const critical = risk.impact === 'CRITICAL' || risk.reversibility === 'IRREVERSIBLE';
  if (critical && risk.probability > 0) {
    return { status: 'REJECT', reasons: ['critical or irreversible downside requires stronger safeguards', ...reasons], success_probability: prediction };
  }
  if (reasons.length) return { status: 'HOLD', reasons, success_probability: prediction };
  return { status: 'PROCEED', reasons: [], success_probability: prediction };
}