export function verifyOutcome(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const probability = input.prediction?.success_probability;
  if (typeof probability !== 'number' || probability < 0 || probability > 1) throw new TypeError('success_probability must be between 0 and 1');
  if (typeof input.observed?.success !== 'boolean') throw new TypeError('observed success is required');
  const prediction_correct = input.observed.success === (probability >= 0.5);
  return {
    status: prediction_correct ? 'MATCHED' : 'MISMATCHED',
    prediction_correct,
    predicted_success: probability >= 0.5,
    observed_success: input.observed.success,
  };
}
