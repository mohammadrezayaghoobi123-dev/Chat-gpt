const SEVERITIES = new Set(['LOW', 'WARNING', 'HIGH', 'CRITICAL']);

export async function runSafeRepair(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('input is required');
  const incident = input.incident ?? {};
  if (!SEVERITIES.has(incident.severity)) throw new TypeError('invalid incident severity');
  if (typeof input.repair !== 'function') throw new TypeError('repair is required');
  if (typeof input.verify !== 'function') throw new TypeError('verify is required');
  if (typeof input.rollback !== 'function') throw new TypeError('rollback is required');
  if (incident.severity === 'CRITICAL') return { status: 'APPROVAL_REQUIRED', incident_id: incident.id };

  await input.repair();
  const verified = await input.verify();
  if (verified === true) return { status: 'REPAIRED', incident_id: incident.id };

  await input.rollback();
  return { status: 'ROLLED_BACK', incident_id: incident.id };
}
