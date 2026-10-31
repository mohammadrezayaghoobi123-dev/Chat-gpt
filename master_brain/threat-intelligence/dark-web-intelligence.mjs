const SOURCE_RELIABILITY = new Set(['A','B','C','D','E','F']);
const CREDIBILITY = new Set([1,2,3,4,5,6]);
const ACTIONS = Object.freeze({MONITOR:'MONITOR',CORRELATE:'CORRELATE',HOLD:'HOLD',BLOCK:'BLOCK',ESCALATE:'ESCALATE'});
const ALLOWED = new Set(['READ','COLLECT_METADATA','CORRELATE','ANALYZE','REPORT']);
const BLOCKED = new Set(['TRANSACT','PURCHASE','CREDENTIAL_USE','MALWARE_ACQUISITION','EXPLOIT_ACQUISITION','INTRUSION','PERSISTENCE','EXFILTRATION']);
export function scoreAdmiralty({source_reliability, information_credibility} = {}) {
  if (!SOURCE_RELIABILITY.has(source_reliability) || !CREDIBILITY.has(information_credibility)) return {status:'INCONCLUSIVE', reason:'invalid confidence dimensions'};
  const code = String(source_reliability) + String(information_credibility);
  return {status:['A1','A2','B1','B2'].includes(code) ? 'ACTIONABLE' : 'NON_ACTIONABLE', code};
}
export function classifyThreatObservation(observation = {}) {
  const confidence = scoreAdmiralty(observation);
  if (observation.source_trust === 'UNKNOWN' || observation.provenance === 'UNKNOWN') return {status:'INCONCLUSIVE', action:ACTIONS.HOLD, confidence};
  if (observation.contradicted === true) return {status:'CONFLICTED', action:ACTIONS.HOLD, confidence};
  if (confidence.status !== 'ACTIONABLE') return {status:'UNCONFIRMED', action:ACTIONS.MONITOR, confidence};
  if (observation.correlated_assets > 0 && observation.technical_indicator_verified === true) return {status:'CORROBORATED', action:ACTIONS.ESCALATE, confidence};
  return {status:'ASSESSED', action:ACTIONS.CORRELATE, confidence};
}
export function authorizeDarkWebOperation({operation} = {}) {
  if (BLOCKED.has(operation)) return {allowed:false, action:ACTIONS.BLOCK, reason:'operation is outside defensive intelligence scope'};
  if (ALLOWED.has(operation)) return {allowed:true, action:ACTIONS.CORRELATE};
  return {allowed:false, action:ACTIONS.HOLD, reason:'unknown operation must fail closed'};
}
export function admitThreatIntelToMemory({observation = {}, evidence_status = 'UNKNOWN'} = {}) {
  const classification = classifyThreatObservation(observation);
  if (classification.status === 'CONFLICTED' || classification.status === 'INCONCLUSIVE') return {status:'QUARANTINED', classification};
  if (evidence_status !== 'VERIFIED' || classification.confidence.status !== 'ACTIONABLE') return {status:'QUARANTINED', classification};
  return {status:'ADMIT_CANDIDATE', classification};
}
export { ACTIONS };