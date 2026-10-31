const CHANNELS = Object.freeze(['stable','extended-stable','beta','dev']);
const ACTIONS = Object.freeze({
  AUTO_STAGE:'AUTO_STAGE',
  AUTO_APPLY:'AUTO_APPLY',
  HOLD:'HOLD',
  REJECT:'REJECT',
  REQUIRE_APPROVAL:'REQUIRE_APPROVAL'
});

export function classifyMaintenanceChange(change = {}) {
  const { channel='stable', security_critical=false, reversible=true, compatibility='UNKNOWN', verification='UNKNOWN', governance_impact=false, permission_impact=false, irreversible=false, capability_change=false } = change;
  if (!CHANNELS.includes(channel)) return { action:ACTIONS.REJECT, reason:'unknown update channel' };
  if (governance_impact || permission_impact || irreversible) return { action:ACTIONS.REQUIRE_APPROVAL, reason:'governance, permission, or irreversible boundary affected' };
  if (compatibility !== 'COMPATIBLE') return { action:ACTIONS.HOLD, reason:'compatibility is not proven' };
  if (verification !== 'PASS') return { action:ACTIONS.HOLD, reason:'verification is not proven' };
  if (!reversible) return { action:ACTIONS.HOLD, reason:'rollback safety is not proven' };
  if (channel === 'dev' || channel === 'beta') return { action:ACTIONS.HOLD, reason:'pre-release channel requires explicit promotion' };
  if (capability_change) return { action:ACTIONS.AUTO_STAGE, reason:'new capability must be staged before activation' };
  if (security_critical) return { action:ACTIONS.AUTO_APPLY, reason:'verified reversible security maintenance' };
  return { action:ACTIONS.AUTO_APPLY, reason:'verified compatible reversible maintenance' };
}

export function canActivateUpdate(change = {}) {
  return classifyMaintenanceChange(change).action === ACTIONS.AUTO_APPLY;
}

export function requireVerifiedBackup({ backup_verified=false } = {}) {
  return backup_verified === true;
}

export function shouldRollback({ health='UNKNOWN', verification='UNKNOWN', migration='UNKNOWN' } = {}) {
  return health !== 'PASS' || verification !== 'PASS' || migration === 'FAIL';
}

export { CHANNELS, ACTIONS };
