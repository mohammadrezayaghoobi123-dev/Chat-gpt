export function calibratePredictions(samples = []) {
  if (!Array.isArray(samples) || samples.length === 0) throw new TypeError('samples are required');
  for (const sample of samples) {
    if (!sample || typeof sample.predicted_probability !== 'number' || sample.predicted_probability < 0 || sample.predicted_probability > 1) throw new TypeError('invalid predicted probability');
    if (typeof sample.observed_success !== 'boolean') throw new TypeError('observed success is required');
  }
  const predicted_rate = samples.reduce((sum, sample) => sum + sample.predicted_probability, 0) / samples.length;
  const observed_rate = samples.filter(sample => sample.observed_success).length / samples.length;
  return { count: samples.length, predicted_rate, observed_rate, calibration_error: Number(Math.abs(predicted_rate - observed_rate).toFixed(6)) };
}
