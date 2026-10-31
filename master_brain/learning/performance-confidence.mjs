export function assessPerformanceConfidence(input = {}) {
  if (!Number.isInteger(input.count) || input.count < 1) throw new TypeError('count must be a positive integer');
  if (typeof input.accuracy !== 'number' || input.accuracy < 0 || input.accuracy > 1) throw new TypeError('accuracy must be between 0 and 1');
  if (typeof input.freshness !== 'number' || input.freshness < 0 || input.freshness > 1) throw new TypeError('freshness must be between 0 and 1');
  const sample_factor = Math.min(1, input.count / 20);
  const score = Number((input.accuracy * sample_factor * input.freshness).toFixed(6));
  const band = score >= 0.8 && input.count >= 20 ? 'HIGH' : score >= 0.5 && input.count >= 5 ? 'MEDIUM' : 'LOW';
  return { score, band, sample_factor };
}
