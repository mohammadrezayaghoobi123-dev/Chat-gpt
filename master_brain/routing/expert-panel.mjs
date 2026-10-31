import { getEligibleModels } from './capability-registry.mjs';

export function buildExpertPanel(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!Array.isArray(input.required_capabilities) || input.required_capabilities.length === 0) {
    throw new TypeError('required_capabilities are required');
  }
  if (!Array.isArray(input.registry)) throw new TypeError('registry must be an array');
  if (typeof input.risk !== 'string') throw new TypeError('risk is required');

  const capabilities = [...new Set(input.required_capabilities)].sort();
  const used = new Set();
  const slots = [];

  for (const capability of capabilities) {
    const eligible = getEligibleModels(input.registry, {
      required_capabilities: [capability],
      risk: input.risk,
    })
      .filter(model => !used.has(model.id))
      .sort((a, b) => b.reliability - a.reliability || a.id.localeCompare(b.id));

    if (eligible.length === 0) throw new Error('no eligible specialist');

    const selected = eligible[0];
    used.add(selected.id);
    slots.push({ capability, models: eligible });
  }

  return {
    multi_specialist: slots.length > 1,
    slots,
  };
}
