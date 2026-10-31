const STATUSES = new Set(['PROVEN', 'MEASURED', 'ESTIMATED', 'UNSUPPORTED', 'UNKNOWN']);
const IMPACTS = new Set(['LOW', 'MEDIUM', 'HIGH']);

export function auditAssumptions(assumptions = []) {
  if (!Array.isArray(assumptions)) throw new TypeError('assumptions must be an array');

  const by_status = Object.fromEntries([...STATUSES].map(status => [status, 0]));
  const normalized = assumptions.map(assumption => {
    if (!assumption || typeof assumption.name !== 'string' || !assumption.name.trim()) {
      throw new TypeError('assumption name is required');
    }
    const status = assumption.status ?? 'UNKNOWN';
    const impact = assumption.impact ?? 'MEDIUM';
    if (!STATUSES.has(status)) throw new TypeError(`invalid assumption status: ${status}`);
    if (!IMPACTS.has(impact)) throw new TypeError(`invalid assumption impact: ${impact}`);
    by_status[status] += 1;
    return { ...assumption, name: assumption.name.trim(), status, impact };
  });

  return {
    total: normalized.length,
    by_status,
    assumptions: normalized,
    high_impact_unverified: normalized.filter(assumption =>
      assumption.impact === 'HIGH' && !['PROVEN', 'MEASURED'].includes(assumption.status)
    ),
  };
}
