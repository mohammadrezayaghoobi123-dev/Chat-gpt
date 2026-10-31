export function updateLearningMemory(memory = {}, observation = {}) {
  if (!memory || typeof memory !== 'object') throw new TypeError('memory is required');
  if (typeof observation.model_id !== 'string' || !observation.model_id.trim()) throw new TypeError('model_id is required');
  if (typeof observation.capability !== 'string' || !observation.capability.trim()) throw new TypeError('capability is required');
  if (typeof observation.prediction_correct !== 'boolean') throw new TypeError('prediction_correct is required');
  const next = structuredClone(memory);
  next.models ??= {};
  const model = next.models[observation.model_id] ??= { capabilities: {} };
  const capability = model.capabilities[observation.capability] ??= { count: 0, correct: 0, accuracy: 0 };
  capability.count += 1;
  if (observation.prediction_correct) capability.correct += 1;
  capability.accuracy = Number((capability.correct / capability.count).toFixed(6));
  return next;
}
