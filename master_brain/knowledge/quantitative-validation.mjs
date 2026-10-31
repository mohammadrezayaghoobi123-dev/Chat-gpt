const UNIT_DIMENSIONS = { kg: 'mass', USD: 'currency', 'USD/kg': 'currency_per_mass' };
function dimension(unit) { return UNIT_DIMENSIONS[unit]; }
export function validateCalculation(input = {}) {
  if (!Array.isArray(input.inputs) || input.inputs.length !== 2) throw new TypeError('two inputs are required');
  if (input.operation !== 'multiply') throw new TypeError('only multiply is supported');
  const [a,b] = input.inputs;
  if (typeof a.value !== 'number' || typeof b.value !== 'number') throw new TypeError('input values must be numbers');
  if (!dimension(a.unit) || !dimension(b.unit)) throw new TypeError('unknown unit');
  if (a.unit === 'kg' && b.unit === 'USD/kg') {
    const value = a.value * b.value;
    if (input.expected?.unit !== 'USD') return { status: 'INVALID_UNITS' };
    if (typeof input.expected.value !== 'number' || !Number.isFinite(input.expected.value)) throw new TypeError('expected value is required');
    if (Math.abs(value - input.expected.value) > 1e-9) return { status: 'INVALID_RESULT', value, unit: 'USD' };
    return { status: 'VALID', value, unit: 'USD' };
  }
  return { status: 'INVALID_UNITS' };
}