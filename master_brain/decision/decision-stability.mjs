export function analyzeDecisionStability(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) throw new TypeError('scenarios are required');
  const actions = input.scenarios.map(s => s?.action);
  if (actions.some(action => typeof action !== 'string' || !action.trim())) throw new TypeError('scenario action is required');
  const unique = [...new Set(actions)];
  return {
    status: unique.length === 1 ? 'ROBUST' : 'FRAGILE',
    action: unique.length === 1 ? unique[0] : undefined,
    actions: unique,
    scenarios: input.scenarios.map(s => ({ name: s.name, action: s.action, outcome: s.outcome }))
  };
}