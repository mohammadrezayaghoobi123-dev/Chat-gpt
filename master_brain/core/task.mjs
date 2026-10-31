const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const STATUSES = new Set(['BACKLOG', 'READY', 'RUNNING', 'BLOCKED', 'REVIEW', 'VERIFIED', 'DONE', 'FAILED', 'RECOVERY']);

export function createTask(input = {}) {
  if (typeof input.objective !== 'string' || !input.objective.trim()) {
    throw new TypeError('objective is required');
  }
  const risk = input.risk ?? 'medium';
  if (!RISKS.has(risk)) throw new TypeError(`invalid risk: ${risk}`);
  const status = input.status ?? 'BACKLOG';
  if (!STATUSES.has(status)) throw new TypeError(`invalid status: ${status}`);
  return {
    type: 'Task',
    objective: input.objective.trim(),
    constraints: [...(input.constraints ?? [])],
    risk,
    required_capabilities: [...(input.required_capabilities ?? [])],
    success_criteria: [...(input.success_criteria ?? [])],
    status,
  };
}
