import { routeAcrossProviders } from './model-provider-registry.mjs';
import { planModelPool } from './model-pool.mjs';

export function routeTask(task, registry = []) {
  if (!task || typeof task !== 'object') throw new TypeError('task is required');
  if (!Array.isArray(registry)) throw new TypeError('registry must be an array');
  if (registry.some(model => model?.provider_id && model?.model_id)) {
    const routed = routeAcrossProviders(registry, task);
    if (routed.status === 'HOLD') throw new Error(routed.reason);
    return routed.providers;
  }
  const risk = task.risk ?? 'medium';
  const validRisks = new Set(['low', 'medium', 'high', 'critical']);
  if (!validRisks.has(risk)) throw new TypeError(`invalid risk: ${risk}`);
  const required = new Set(task.required_capabilities ?? []);
  const eligible = registry.filter(model =>
    Array.isArray(model.capabilities) &&
    [...required].every(capability => model.capabilities.includes(capability)) &&
    Array.isArray(model.risk_levels) && model.risk_levels.includes(risk)
  );
  if (!eligible.length) throw new Error(`no eligible model for risk=${risk}`);
  return [...eligible].sort((a, b) => {
    if (risk === 'low') return (a.cost ?? 1) - (b.cost ?? 1) || (b.reliability ?? 0) - (a.reliability ?? 0);
    return (b.reliability ?? 0) - (a.reliability ?? 0) || (a.cost ?? 1) - (b.cost ?? 1);
  });
}

export function routeTaskWithModelPool(task, registry = [], signals = {}) {
  return planModelPool(task, registry, signals);
}
