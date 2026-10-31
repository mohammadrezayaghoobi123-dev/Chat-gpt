const RISKS = new Set(['low', 'medium', 'high', 'critical']);

export function createCapabilityRegistry(models = []) {
  if (!Array.isArray(models)) throw new TypeError('models must be an array');
  const ids = new Set();
  return models.map(model => {
    if (!model?.id) throw new TypeError('model id is required');
    if (ids.has(model.id)) throw new TypeError(`duplicate model id: ${model.id}`);
    ids.add(model.id);
    if (!Array.isArray(model.capabilities)) throw new TypeError(`capabilities required: ${model.id}`);
    if (typeof model.reliability !== 'number' || model.reliability < 0 || model.reliability > 1) {
      throw new TypeError(`invalid reliability: ${model.id}`);
    }
    if (!Array.isArray(model.risk_levels) || model.risk_levels.some(risk => !RISKS.has(risk))) {
      throw new TypeError(`invalid risk_levels: ${model.id}`);
    }
    return { ...model, capabilities: [...new Set(model.capabilities)], risk_levels: [...new Set(model.risk_levels)] };
  });
}

export function getEligibleModels(registry, task) {
  if (!Array.isArray(registry)) throw new TypeError('registry must be an array');
  const required = new Set(task.required_capabilities ?? []);
  return registry.filter(model =>
    model.risk_levels.includes(task.risk) &&
    [...required].every(capability => model.capabilities.includes(capability))
  );
}
