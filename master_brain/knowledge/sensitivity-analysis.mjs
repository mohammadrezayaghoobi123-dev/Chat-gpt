export function analyzeSensitivity(input = {}) {
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) throw new TypeError('scenarios are required');
  if (typeof input.decision !== 'function') throw new TypeError('decision function is required');
  const outcomes = input.scenarios.map(scenario => ({ name: scenario.name, value: input.decision(scenario.variables) }));
  const values = outcomes.map(x => x.value);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError('scenario outcomes must be finite numbers');
  const min = Math.min(...values), max = Math.max(...values);
  const baseline = input.baseline ?? values[0];
  const spread = Math.abs(max - min);
  const tolerance = input.tolerance ?? 0;
  const status = spread === 0 ? 'ROBUST' : spread <= tolerance ? 'ROBUST' : spread <= Math.abs(baseline || 1) * 0.2 ? 'SENSITIVE' : 'UNSTABLE';
  return { status, baseline, min, max, spread, outcomes };
}